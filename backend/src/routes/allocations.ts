import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { agentBranchClamp, customerBranchClamp, resolveBranchClamp } from "../services/scope";

/**
 * Manual allocation (build brief Section 5): TL filters the unallocated queue,
 * multi-selects customers, assigns them to an agent on their team. Reallocation
 * is the same action but must carry a reason; every move lands in allocation_logs.
 */
const router = Router();
router.use(authenticate, requirePermission("customers.allocate"));

router.get(
  "/unallocated",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        company_id: z.string().uuid().optional(),
        product: z.string().optional(),
        bucket: z.string().optional(),
        customer_branch: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const conditions = [
      "co.agency_id = $1",
      "c.assigned_agent_id IS NULL",
      "c.status = 'active'",
    ];
    const params: unknown[] = [req.user!.agency_id];

    // A branch_manager only ever sees their own branch's unallocated queue --
    // forced, not optional like the customer_branch filter below (which just
    // narrows further within whatever they're already clamped to).
    const clamp = await resolveBranchClamp(req.user!);
    const clampSql = customerBranchClamp(clamp, params);
    if (clampSql) conditions.push(clampSql.replace(/^ AND /, ""));

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
    if (q.customer_branch) {
      params.push(q.customer_branch);
      const n = params.length;
      conditions.push(
        `(c.branch_id::text = $${n} OR (c.branch_id IS NULL AND (c.custom_fields->>'branch' ILIKE '%' || $${n} || '%' OR c.custom_fields->>'Branch' ILIKE '%' || $${n} || '%')))`
      );
    }

    const where = conditions.join(" AND ");
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM customers c JOIN companies co ON co.id = c.company_id
        WHERE ${where}`,
      params,
    );

    params.push(q.limit, (q.page - 1) * q.limit);
    const { rows } = await pool.query(
      `SELECT c.id, c.loan_number, c.customer_name, c.mobile_number,
              c.product, c.bucket, c.due_amount, c.pos, c.emi, c.branch_id,
              co.name AS company_name,
              COALESCE(b.name, NULLIF(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')), '')) AS branch_name
         FROM customers c JOIN companies co ON co.id = c.company_id
         LEFT JOIN branches b ON b.id = c.branch_id
        WHERE ${where}
        ORDER BY c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    res.json({ customers: rows, total: countResult.rows[0].total, page: q.page, limit: q.limit });
  }),
);

const assignBody = z.object({
  customer_ids: z.array(z.string().uuid()).min(1).max(500),
  agent_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

router.post(
  "/assign",
  asyncHandler(async (req, res) => {
    const body = assignBody.parse(req.body);
    const agencyId = req.user!.agency_id;
    const clamp = await resolveBranchClamp(req.user!);

    // Target must be an active workable user in this agency (and, for a
    // branch_manager, in their own branch too). branch_manager has no
    // boolean flag of its own, so it needs an explicit disjunct here.
    const agentParams: unknown[] = [body.agent_id, agencyId];
    const agentBranchSql = agentBranchClamp(clamp, agentParams, "users");
    const agentRes = await pool.query(
      `SELECT id, team_id, full_name FROM users
        WHERE id = $1 AND agency_id = $2 AND is_active = true
          AND (is_telecaller OR is_field_agent OR designation = 'branch_manager')${agentBranchSql}`,
      agentParams,
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new HttpError(404, "Agent not found (must be an active telecaller / field agent / branch manager in this agency)");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the target customers; verify agency scope, branch clamp, and
      // active status.
      const custParams: unknown[] = [body.customer_ids, agencyId];
      const custBranchSql = customerBranchClamp(clamp, custParams);
      const custRes = await client.query(
        `SELECT c.id, c.assigned_agent_id FROM customers c
           JOIN companies co ON co.id = c.company_id
          WHERE c.id = ANY($1) AND co.agency_id = $2 AND c.status = 'active'${custBranchSql}
          FOR UPDATE OF c`,
        custParams,
      );
      if (custRes.rows.length !== body.customer_ids.length) {
        throw new HttpError(404, "One or more customers not found (or already closed) in this agency");
      }

      // Reallocation (already assigned to someone else) requires a reason.
      const reallocations = custRes.rows.filter(
        (c) => c.assigned_agent_id && c.assigned_agent_id !== body.agent_id,
      );
      if (reallocations.length > 0 && !body.reason) {
        throw new HttpError(400, `${reallocations.length} customer(s) are already allocated — provide a reason to reallocate`);
      }

      await client.query(
        `UPDATE customers SET assigned_agent_id = $1, assigned_team_id = $2 WHERE id = ANY($3)`,
        [body.agent_id, agent.team_id, body.customer_ids],
      );

      // One INSERT per customer previously meant up to 500 round-trips
      // inside this same transaction for a large batch assign -- a single
      // parallel-unnest INSERT does the same rows in one round-trip.
      const toLog = custRes.rows.filter((c) => c.assigned_agent_id !== body.agent_id);
      if (toLog.length > 0) {
        await client.query(
          `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason, slot)
           SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[])`,
          [
            toLog.map((c) => c.id),
            toLog.map((c) => c.assigned_agent_id),
            toLog.map(() => body.agent_id),
            toLog.map(() => req.user!.id),
            toLog.map(() => body.reason ?? null),
            toLog.map(() => "primary"),
          ],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({
      assigned: body.customer_ids.length,
      agent_id: body.agent_id,
      agent_name: agent.full_name,
    });
  }),
);

/** Assign a field agent (secondary slot) to already-allocated customers. */
router.post(
  "/assign-field-agent",
  asyncHandler(async (req, res) => {
    const body = assignBody.parse(req.body);
    const agencyId = req.user!.agency_id;
    const clamp = await resolveBranchClamp(req.user!);

    const agentParams: unknown[] = [body.agent_id, agencyId];
    const agentBranchSql = agentBranchClamp(clamp, agentParams, "users");
    const agentRes = await pool.query(
      `SELECT id, team_id, full_name FROM users
        WHERE id = $1 AND agency_id = $2 AND is_active = true AND is_field_agent = true${agentBranchSql}`,
      agentParams,
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new HttpError(404, "Agent not found (must be an active field agent in this agency)");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const custParams: unknown[] = [body.customer_ids, agencyId];
      const custBranchSql = customerBranchClamp(clamp, custParams);
      const custRes = await client.query(
        `SELECT c.id, c.assigned_field_agent_id FROM customers c
           JOIN companies co ON co.id = c.company_id
          WHERE c.id = ANY($1) AND co.agency_id = $2 AND c.status = 'active'${custBranchSql}
          FOR UPDATE OF c`,
        custParams,
      );
      if (custRes.rows.length !== body.customer_ids.length) {
        throw new HttpError(404, "One or more customers not found (or already closed) in this agency");
      }

      const reallocations = custRes.rows.filter(
        (c) => c.assigned_field_agent_id && c.assigned_field_agent_id !== body.agent_id,
      );
      if (reallocations.length > 0 && !body.reason) {
        throw new HttpError(400, `${reallocations.length} customer(s) already have a field agent — provide a reason to reassign`);
      }

      await client.query(
        `UPDATE customers SET assigned_field_agent_id = $1 WHERE id = ANY($2)`,
        [body.agent_id, body.customer_ids],
      );

      const toLog = custRes.rows.filter((c) => c.assigned_field_agent_id !== body.agent_id);
      if (toLog.length > 0) {
        await client.query(
          `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason, slot)
           SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[])`,
          [
            toLog.map((c) => c.id),
            toLog.map((c) => c.assigned_field_agent_id),
            toLog.map(() => body.agent_id),
            toLog.map(() => req.user!.id),
            toLog.map(() => body.reason ?? null),
            toLog.map(() => "field"),
          ],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({
      assigned: body.customer_ids.length,
      agent_id: body.agent_id,
      agent_name: agent.full_name,
    });
  }),
);

/** Allocation history for one customer (who moved it, when, why). */
router.get(
  "/logs",
  asyncHandler(async (req, res) => {
    const customerId = z.string().uuid().parse(req.query.customer_id);
    const clamp = await resolveBranchClamp(req.user!);
    const params: unknown[] = [customerId, req.user!.agency_id];
    const branchSql = customerBranchClamp(clamp, params);
    const { rows } = await pool.query(
      `SELECT al.id, al.reason, al.created_at, al.slot,
              f.full_name AS from_agent_name,
              t.full_name AS to_agent_name,
              b.full_name AS allocated_by_name
         FROM allocation_logs al
         JOIN customers c ON c.id = al.customer_id
         JOIN companies co ON co.id = c.company_id
         LEFT JOIN users f ON f.id = al.from_agent_id
         JOIN users t ON t.id = al.to_agent_id
         JOIN users b ON b.id = al.allocated_by
        WHERE al.customer_id = $1 AND co.agency_id = $2${branchSql}
        ORDER BY al.created_at DESC`,
      params,
    );
    res.json({ logs: rows });
  }),
);

export default router;
