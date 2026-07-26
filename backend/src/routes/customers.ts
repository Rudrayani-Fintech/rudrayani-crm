import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { resolveFieldCatalog } from "../services/field-config-service";
import { capabilitiesHavePermission } from "../services/permission-service";
import { customerBranchClamp, resolveBranchClamp } from "../services/scope";
import { capabilitiesOf } from "../types/user";

const router = Router();
router.use(authenticate, requirePermission("customers.view"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        company_id: z.string().uuid().optional(),
        product: z.string().optional(),
        bucket: z.string().optional(),
        status: z.enum(["active", "closed", "recalled"]).optional(),
        assigned: z.enum(["true", "false"]).optional(),
        agent_id: z.string().uuid().optional(),
        field_agent_id: z.string().uuid().optional(),
        branch_id: z.string().uuid().optional(),
        customer_branch: z.string().optional(),
        team_id: z.string().uuid().optional(),
        q: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const conditions: string[] = ["co.agency_id = $1"];
    const params: unknown[] = [req.user!.agency_id];

    // A caller without customers.allocate can only ever see their own
    // assigned customers here -- unconditionally, so agent_id/field_agent_id
    // below can't be used to peek at someone else's book. (The single-customer
    // GET /:id route below already had this check; the list route didn't.)
    const canSeeAnyCustomer = await capabilitiesHavePermission(
      capabilitiesOf(req.user!),
      "customers.allocate",
    );
    if (!canSeeAnyCustomer) {
      params.push(req.user!.id);
      conditions.push(
        `(c.assigned_agent_id = $${params.length} OR c.assigned_field_agent_id = $${params.length})`,
      );
    } else {
      // Between "own record only" and "whole agency" -- a branch_manager
      // (who does hold customers.allocate) only ever sees their own branch.
      const clamp = await resolveBranchClamp(req.user!);
      const clampSql = customerBranchClamp(clamp, params);
      if (clampSql) conditions.push(clampSql.replace(/^ AND /, ""));
    }

    if (q.company_id) {
      params.push(q.company_id);
      conditions.push(`c.company_id = $${params.length}`);
    }
    if (q.product) {
      params.push(q.product);
      conditions.push(`c.product = $${params.length}`);
    }
    if (q.bucket) {
      params.push(q.bucket);
      conditions.push(`c.bucket = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      conditions.push(`c.status = $${params.length}`);
    }
    if (q.assigned === "true") conditions.push("c.assigned_agent_id IS NOT NULL");
    if (q.assigned === "false") conditions.push("c.assigned_agent_id IS NULL");
    if (q.agent_id) {
      params.push(q.agent_id);
      conditions.push(`c.assigned_agent_id = $${params.length}`);
    }
    if (q.field_agent_id) {
      params.push(q.field_agent_id);
      conditions.push(`c.assigned_field_agent_id = $${params.length}`);
    }
    if (q.team_id) {
      params.push(q.team_id);
      conditions.push(`c.assigned_team_id = $${params.length}`);
    }
    if (q.branch_id) {
      params.push(q.branch_id);
      conditions.push(`c.branch_id = $${params.length}`);
    }
    if (q.customer_branch) {
      params.push(q.customer_branch);
      const n = params.length;
      conditions.push(
        `(c.branch_id::text = $${n} OR (c.branch_id IS NULL AND (c.custom_fields->>'branch' ILIKE '%' || $${n} || '%' OR c.custom_fields->>'Branch' ILIKE '%' || $${n} || '%')))`
      );
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      const n = params.length;
      conditions.push(
        `(c.customer_name ILIKE $${n} OR c.loan_number ILIKE $${n} OR c.mobile_number ILIKE $${n})`,
      );
    }

    const where = conditions.join(" AND ");

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM customers c
         JOIN companies co ON co.id = c.company_id
        WHERE ${where}`,
      params,
    );

    const offset = (q.page - 1) * q.limit;
    params.push(q.limit, offset);

    const { rows } = await pool.query(
      `SELECT c.id, c.loan_number, c.customer_name, c.mobile_number,
              c.product, c.bucket, c.due_amount, c.pos, c.emi, c.status, c.recalled_at,
              c.custom_fields, c.created_at, c.assigned_agent_id, c.assigned_field_agent_id, c.branch_id,
              a.full_name AS assigned_agent_name,
              f.full_name AS assigned_field_agent_name,
              co.name AS company_name, co.id AS company_id,
              COALESCE(b.name, NULLIF(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')), '')) AS branch_name
         FROM customers c
         JOIN companies co ON co.id = c.company_id
         LEFT JOIN users a ON a.id = c.assigned_agent_id
         LEFT JOIN users f ON f.id = c.assigned_field_agent_id
         LEFT JOIN branches b ON b.id = c.branch_id
        WHERE ${where}
        ORDER BY c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    res.json({
      customers: rows,
      total: countResult.rows[0].total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

router.get(
  "/branches",
  asyncHandler(async (req, res) => {
    // A branch_manager previously got every branch name in the agency here
    // (no clamp at all) -- enough to enumerate the whole org structure from
    // what's meant to be a scoped filter dropdown. Clamp the same way every
    // other customer-scoped route does.
    // Both SELECT halves of the UNION are one query against one params
    // array -- $1 (agency_id) is shared, then each customerBranchClamp()
    // call appends its own pair of positional params for that half only.
    const clamp = await resolveBranchClamp(req.user!);
    const params: unknown[] = [req.user!.agency_id];
    const structuredClamp = customerBranchClamp(clamp, params, "c");
    params.push(req.user!.agency_id);
    const agencyIdParam2 = params.length;
    const freetextClamp = customerBranchClamp(clamp, params, "c");
    const { rows } = await pool.query(
      `SELECT DISTINCT b.id::text AS value, b.name AS label
       FROM customers c
       JOIN companies co ON co.id = c.company_id
       JOIN branches b ON b.id = c.branch_id
       WHERE co.agency_id = $1 ${structuredClamp}
       UNION
       SELECT DISTINCT UPPER(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch'))) AS value,
                       UPPER(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch'))) AS label
       FROM customers c
       JOIN companies co ON co.id = c.company_id
       WHERE co.agency_id = $${agencyIdParam2}
         AND c.branch_id IS NULL
         AND COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch') IS NOT NULL
         AND TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')) != ''
         ${freetextClamp}
       ORDER BY label`,
      params,
    );
    res.json({ branches: rows });
  }),
);

/**
 * Customer 360 view (Phase 7): identity + the source columns the agency chose
 * to keep as "detail" fields at import time, plus every trail of activity —
 * calls, PTPs, payments, bucket movements, allocation history, month
 * snapshots. Telecallers/field agents (no customers.allocate) may only open
 * their OWN assigned customers; 404 rather than 403 so the scope check
 * doesn't leak whether an out-of-scope loan number exists.
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    // A branch_manager (holds customers.allocate) can only open customers in
    // their own branch -- fold that into the lookup itself so an
    // out-of-branch id 404s the same way an out-of-scope one already does
    // for a plain agent, rather than fetching first and checking after.
    const canSeeAnyCustomer = await capabilitiesHavePermission(
      capabilitiesOf(req.user!),
      "customers.allocate",
    );
    const clamp = canSeeAnyCustomer ? await resolveBranchClamp(req.user!) : null;
    const params: unknown[] = [id, req.user!.agency_id];
    const clampSql = customerBranchClamp(clamp, params);

    const { rows: customerRows } = await pool.query(
      `SELECT c.*, co.name AS company_name, co.id AS company_id_check,
              ua.full_name AS assigned_agent_name,
              uf.full_name AS assigned_field_agent_name
         FROM customers c
         JOIN companies co ON co.id = c.company_id
         LEFT JOIN users ua ON ua.id = c.assigned_agent_id
         LEFT JOIN users uf ON uf.id = c.assigned_field_agent_id
        WHERE c.id = $1 AND co.agency_id = $2${clampSql}`,
      params,
    );
    const customer = customerRows[0];
    if (!customer) throw new HttpError(404, "Customer not found");

    if (
      !canSeeAnyCustomer &&
      customer.assigned_agent_id !== req.user!.id &&
      customer.assigned_field_agent_id !== req.user!.id
    ) {
      throw new HttpError(404, "Customer not found");
    }

    const [
      detailFields,
      fieldCatalog,
      trail,
      ptps,
      payments,
      bucketMovements,
      allocationHistory,
      snapshots,
      fieldVisits,
      attachments,
    ] = await Promise.all([
        // "Latest" = most recently touched active template for this company.
        // Version is scoped per template NAME, so it can't be used to compare
        // across different named templates -- updated_at can.
        pool.query(
          `SELECT detail_fields FROM import_templates
            WHERE company_id = $1 AND is_active = true
            ORDER BY updated_at DESC LIMIT 1`,
          [customer.company_id],
        ),
        // Admin's Field Config "required" toggle (company_field_settings.is_required)
        // otherwise never reached a customer-facing view -- see field_catalog below.
        resolveFieldCatalog(customer.company_id),
        pool.query(
          `SELECT cl.id, cl.remark, cl.call_duration_seconds, cl.details, cl.created_at,
                  dc.action_code, dc.result_code, u.full_name AS agent_name
             FROM call_logs cl
             LEFT JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
             LEFT JOIN users u ON u.id = cl.agent_id
            WHERE cl.customer_id = $1
            ORDER BY cl.created_at DESC LIMIT 50`,
          [id],
        ),
        pool.query(
          `SELECT id, amount, promised_date, mode, status, created_at
             FROM ptps WHERE customer_id = $1 ORDER BY created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT id, amount, mode, photo_proof_url, paid_at, deposited_at
             FROM payments WHERE customer_id = $1 ORDER BY paid_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT id, from_bucket, to_bucket, trigger, month, detected_at
             FROM bucket_movements WHERE customer_id = $1 ORDER BY detected_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT al.id, al.reason, al.created_at, al.slot,
                  fu.full_name AS from_agent_name, tu.full_name AS to_agent_name,
                  bu.full_name AS allocated_by_name
             FROM allocation_logs al
             LEFT JOIN users fu ON fu.id = al.from_agent_id
             JOIN users tu ON tu.id = al.to_agent_id
             JOIN users bu ON bu.id = al.allocated_by
            WHERE al.customer_id = $1
            ORDER BY al.created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT month, bucket, due_amount, pos, emi, product
             FROM customer_month_snapshots WHERE customer_id = $1 ORDER BY month DESC`,
          [id],
        ),
        pool.query(
          `SELECT fv.id, fv.remark, fv.created_at,
                  (fv.photo_url IS NOT NULL) AS has_photo,
                  u.full_name AS agent_name
             FROM field_visits fv
             JOIN users u ON u.id = fv.agent_id
            WHERE fv.customer_id = $1
            ORDER BY fv.created_at DESC LIMIT 50`,
          [id],
        ),
        pool.query(
          `SELECT a.id, a.kind, a.file_name, a.mime_type, a.size_bytes, a.note, a.created_at,
                  u.full_name AS uploaded_by_name
             FROM attachments a
             JOIN users u ON u.id = a.uploaded_by
            WHERE a.customer_id = $1
            ORDER BY a.created_at DESC LIMIT 50`,
          [id],
        ),
      ]);

    res.json({
      customer,
      company_name: customer.company_name,
      detail_fields: detailFields.rows[0]?.detail_fields ?? [],
      // field_key -> is_required, for every enabled field of this customer's
      // company -- lets the customer-detail UI mark required fields instead
      // of that config being visible only on the admin Field Config page.
      field_catalog: fieldCatalog.filter((f) => f.is_enabled),
      trail: trail.rows,
      ptps: ptps.rows,
      payments: payments.rows,
      bucket_movements: bucketMovements.rows,
      allocation_history: allocationHistory.rows,
      snapshots: snapshots.rows,
      field_visits: fieldVisits.rows,
      attachments: attachments.rows,
    });
  }),
);

// Update customer branch_id (Track 3, Phase 3.2)
router.patch(
  "/:id/branch",
  requirePermission("customers.allocate"),
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({ branch_id: z.string().uuid().optional().nullable() }).parse(req.body);

    // A branch_manager can only re-branch a customer that's already theirs,
    // and only into their own branch -- otherwise this is a way to both peek
    // at and move customers across the whole agency.
    const clamp = await resolveBranchClamp(req.user!);
    if (clamp && body.branch_id && body.branch_id !== clamp.branchId) {
      throw new HttpError(403, "A Branch Manager can only assign customers to their own branch.");
    }

    // Verify customer exists (and, if clamped, belongs to this branch already)
    const customerParams: unknown[] = [id, req.user!.agency_id];
    const customerClampSql = customerBranchClamp(clamp, customerParams);
    const { rows: customerRows } = await pool.query(
      `SELECT c.id FROM customers c
        JOIN companies co ON co.id = c.company_id
       WHERE c.id = $1 AND co.agency_id = $2${customerClampSql}`,
      customerParams,
    );
    if (!customerRows[0]) throw new HttpError(404, "Customer not found");

    // Validate branch if provided
    if (body.branch_id) {
      const { rows: branchRows } = await pool.query(
        "SELECT 1 FROM branches WHERE id = $1 AND agency_id = $2",
        [body.branch_id, req.user!.agency_id],
      );
      if (!branchRows[0]) throw new HttpError(400, "Branch not found in this agency");
    }

    // Update customer branch_id
    await pool.query("UPDATE customers SET branch_id = $1 WHERE id = $2", [
      body.branch_id ?? null,
      id,
    ]);

    res.json({ success: true });
  }),
);

export default router;
