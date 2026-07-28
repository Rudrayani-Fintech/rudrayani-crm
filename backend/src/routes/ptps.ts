import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { capabilitiesOf } from "../types/user";
import { capabilitiesHavePermission } from "../services/permission-service";
import { refreshNextActionDate } from "../services/ptp-service";
import { agentBranchClamp, customerWriteScopeClamp, resolveBranchClamp } from "../services/scope";
import { istToday } from "../utils/ist";

const router = Router();
router.use(authenticate, requirePermission("calls.log"));

/**
 * PTP list, filterable by customer/status. Agents see their own PTPs plus the
 * full PTP history of customers currently assigned to them (the mobile PTP
 * screen shows a customer's history); customers.allocate (TL and up) sees the
 * whole agency's.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        customer_id: z.string().uuid().optional(),
        status: z.enum(["pending", "kept", "broken"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);

    const seesAll = await capabilitiesHavePermission(
      capabilitiesOf(req.user!),
      "customers.allocate",
    );

    const params: unknown[] = [req.user!.agency_id];
    const filters: string[] = [];
    if (q.customer_id) {
      params.push(q.customer_id);
      filters.push(`p.customer_id = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      filters.push(`p.status = $${params.length}`);
    }
    if (!seesAll) {
      params.push(req.user!.id);
      filters.push(`(p.agent_id = $${params.length} OR c.assigned_agent_id = $${params.length})`);
    } else {
      // Between "own PTPs only" and "whole agency" -- a branch_manager only
      // ever sees their own branch's agents' PTPs.
      const clamp = await resolveBranchClamp(req.user!);
      const clampSql = agentBranchClamp(clamp, params, "u");
      if (clampSql) filters.push(clampSql.replace(/^ AND /, ""));
    }

    const where = `WHERE co.agency_id = $1 ${filters.map((f) => `AND ${f}`).join("\n          ")}`;

    // Previously a hard LIMIT 100 with no offset and no real total, so the
    // client silently saw a truncated list with no way to tell more existed
    // or to reach it -- the one caller today (mobile's PTP screen) always
    // scopes to a single customer_id so this never bit in practice, but a
    // future agency-wide PTP register (Phase 6.3, deferred) would hit it
    // immediately without a real page/limit contract in place first.
    const countParams = [...params];
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
         FROM ptps p
         JOIN customers c ON c.id = p.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = p.agent_id
        ${where}`,
      countParams,
    );
    const total = Number(countRows[0]?.count ?? 0);

    params.push(q.limit, (q.page - 1) * q.limit);
    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.promised_date, p.mode, p.status, p.created_at,
              c.id AS customer_id, c.loan_number, c.customer_name,
              p.agent_id, u.full_name AS agent_name
         FROM ptps p
         JOIN customers c ON c.id = p.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = p.agent_id
        ${where}
        ORDER BY p.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ ptps: rows, total, page: q.page, limit: q.limit });
  }),
);

/**
 * PTP reminders due (build brief Section 6: PTP → Reminder). Agents see their
 * own promises; anyone with customers.allocate (TL and up) sees the whole
 * agency's so they can chase the team.
 */
router.get(
  "/due",
  asyncHandler(async (req, res) => {
    const q = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.query);
    const dueBy = q.date ?? istToday();

    const seesAll = await capabilitiesHavePermission(
      capabilitiesOf(req.user!),
      "customers.allocate",
    );

    const params: unknown[] = [req.user!.agency_id, dueBy];
    let agentFilter = "";
    if (!seesAll) {
      params.push(req.user!.id);
      agentFilter = `AND p.agent_id = $${params.length}`;
    } else {
      const clamp = await resolveBranchClamp(req.user!);
      agentFilter = agentBranchClamp(clamp, params, "u");
    }

    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.promised_date, p.mode, p.status, p.created_at,
              c.id AS customer_id, c.loan_number, c.customer_name, c.mobile_number,
              co.name AS company_name,
              u.full_name AS agent_name
         FROM ptps p
         JOIN customers c ON c.id = p.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = p.agent_id
        WHERE co.agency_id = $1
          AND p.status = 'pending'
          AND p.promised_date <= $2
          ${agentFilter}
        ORDER BY p.promised_date ASC, p.amount DESC`,
      params,
    );
    res.json({ ptps: rows, total: rows.length, due_by: dueBy });
  }),
);

const createSchema = z.object({
  customer_id: z.string().uuid(),
  amount: z.coerce.number().positive(),
  promised_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  mode: z.string().trim().min(1).max(60).optional(),
});

/**
 * Standalone PTP creation (Phase 2.2): previously a PTP could only come
 * into existence as a side effect of logging a call with a PTP-flavored
 * disposition -- there was no first-class "create a promise" action
 * anywhere in the product, mobile or web, despite it being the single most
 * important record type in a collections workflow.
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);

    const scopeParams: unknown[] = [body.customer_id, req.user!.agency_id];
    const scopeClause = await customerWriteScopeClamp(req.user!, scopeParams, "c");
    const custRes = await pool.query(
      `SELECT c.id FROM customers c JOIN companies co ON co.id = c.company_id
        WHERE c.id = $1 AND co.agency_id = $2 AND c.status = 'active' ${scopeClause}`,
      scopeParams,
    );
    if (!custRes.rows[0]) throw new HttpError(404, "Customer not found or already closed");

    const { rows } = await pool.query(
      `INSERT INTO ptps (customer_id, agent_id, amount, promised_date, mode)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [body.customer_id, req.user!.id, body.amount, body.promised_date, body.mode ?? null],
    );
    await refreshNextActionDate(pool, body.customer_id);
    res.status(201).json({ ptp: rows[0] });
  }),
);

const patchSchema = z.object({
  amount: z.coerce.number().positive().optional(),
  promised_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  mode: z.string().trim().min(1).max(60).optional(),
  // Manual override -- e.g. a customer paid in a way that never went
  // through the app's payment flow (cheque handed to a branch office),
  // or the agent needs to correct a wrongly-broken promise.
  status: z.enum(["pending", "kept", "broken"]).optional(),
  kept_amount: z.coerce.number().positive().optional(),
});

/**
 * Edit/reschedule a PTP, or manually mark it kept/broken. Same owner-or-
 * branch-scoped access as the list endpoint above and reminders.ts's PATCH.
 */
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = patchSchema.parse(req.body);
    if (Object.keys(body).length === 0) throw new HttpError(400, "No fields to update");

    const seesAll = await capabilitiesHavePermission(capabilitiesOf(req.user!), "customers.allocate");
    const params: unknown[] = [id, req.user!.agency_id];
    let ownerClause = "";
    if (!seesAll) {
      params.push(req.user!.id);
      ownerClause = `AND agent_id = $${params.length}`;
    } else {
      const clamp = await resolveBranchClamp(req.user!);
      if (clamp) {
        params.push(clamp.branchId);
        const n = params.length;
        ownerClause = `AND EXISTS (SELECT 1 FROM users ru WHERE ru.id = agent_id AND (ru.branch_id = $${n} OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = ru.id AND tb.branch_id = $${n})))`;
      }
    }

    const setClauses: string[] = [];
    if (body.amount !== undefined) {
      params.push(body.amount);
      setClauses.push(`amount = $${params.length}`);
    }
    if (body.promised_date !== undefined) {
      params.push(body.promised_date);
      setClauses.push(`promised_date = $${params.length}`);
    }
    if (body.mode !== undefined) {
      params.push(body.mode);
      setClauses.push(`mode = $${params.length}`);
    }
    if (body.status !== undefined) {
      params.push(body.status);
      setClauses.push(`status = $${params.length}`);
    }
    if (body.kept_amount !== undefined) {
      params.push(body.kept_amount);
      setClauses.push(`kept_amount = $${params.length}`);
    }

    const { rows } = await pool.query(
      `UPDATE ptps SET ${setClauses.join(", ")}
        WHERE id = $1
          AND EXISTS (
            SELECT 1 FROM customers c JOIN companies co ON co.id = c.company_id
             WHERE c.id = ptps.customer_id AND co.agency_id = $2
          )
          ${ownerClause}
        RETURNING *`,
      params,
    );
    if (!rows[0]) throw new HttpError(404, "PTP not found");
    await refreshNextActionDate(pool, rows[0].customer_id as string);
    res.json({ ptp: rows[0] });
  }),
);

export default router;
