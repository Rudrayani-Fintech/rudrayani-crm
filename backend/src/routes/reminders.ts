import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { capabilitiesOf } from "../types/user";
import { capabilitiesHavePermission } from "../services/permission-service";
import { agentBranchClamp, customerWriteScopeClamp, resolveBranchClamp } from "../services/scope";

const router = Router();
router.use(authenticate, requirePermission("reminders.manage"));

const IST = "Asia/Kolkata";

const createSchema = z.object({
  customer_id: z.string().uuid().optional(),
  remind_at: z.string().datetime({ offset: true }).or(z.string().datetime()),
  note: z.string().trim().max(500).optional(),
  client_key: z.string().uuid().optional(),
});

/**
 * Reminders are always created for the caller — creating one on behalf of
 * someone else is a non-goal for v1, which keeps agent-scoping trivial.
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);

    if (body.client_key) {
      const existing = await pool.query(
        "SELECT * FROM reminders WHERE created_by = $1 AND client_key = $2",
        [req.user!.id, body.client_key],
      );
      if (existing.rows[0]) {
        return res.json({ reminder: existing.rows[0], duplicate: true });
      }
    }

    if (body.customer_id) {
      // Previously checked only agency_id -- any user with reminders.manage
      // could create a reminder against any customer in the agency.
      const scopeParams: unknown[] = [body.customer_id, req.user!.agency_id];
      const scopeClause = await customerWriteScopeClamp(req.user!, scopeParams, "c");
      const { rows } = await pool.query(
        `SELECT 1 FROM customers c
           JOIN companies co ON co.id = c.company_id
          WHERE c.id = $1 AND co.agency_id = $2 ${scopeClause}`,
        scopeParams,
      );
      if (rows.length === 0) throw new HttpError(404, "Customer not found");
    }

    const { rows } = await pool.query(
      `INSERT INTO reminders (agency_id, customer_id, agent_id, remind_at, note, created_by, client_key)
       VALUES ($1, $2, $3, $4, $5, $3, $6)
       RETURNING *`,
      [
        req.user!.agency_id,
        body.customer_id ?? null,
        req.user!.id,
        body.remind_at,
        body.note ?? null,
        body.client_key ?? null,
      ],
    );
    res.status(201).json({ reminder: rows[0] });
  }),
);

const listSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  status: z.enum(["pending", "done", "cancelled", "all"]).default("pending"),
  agent_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
});

/**
 * Non-customers.allocate callers are silently clamped to their own reminders
 * (an unauthorized agent_id is simply ignored, not rejected — same pattern
 * as /ptps/due).
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = listSchema.parse(req.query);
    const seesAll = await capabilitiesHavePermission(
      capabilitiesOf(req.user!),
      "customers.allocate",
    );

    const params: unknown[] = [req.user!.agency_id];
    const filters: string[] = [];

    if (q.status !== "all") {
      params.push(q.status);
      filters.push(`r.status = $${params.length}`);
    }
    if (q.customer_id) {
      params.push(q.customer_id);
      filters.push(`r.customer_id = $${params.length}`);
    }
    if (q.date) {
      params.push(q.date);
      filters.push(
        `r.remind_at >= ($${params.length}::date::timestamp AT TIME ZONE '${IST}')` +
          ` AND r.remind_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE '${IST}')`,
      );
    }
    if (q.from) {
      params.push(q.from);
      filters.push(`r.remind_at >= $${params.length}`);
    }
    if (q.to) {
      params.push(q.to);
      filters.push(`r.remind_at <= $${params.length}`);
    }

    if (!seesAll) {
      params.push(req.user!.id);
      filters.push(`r.agent_id = $${params.length}`);
    } else {
      // Between "own reminders only" and "whole agency" -- a branch_manager
      // only ever sees their own branch's agents' reminders; agent_id (if
      // sent) further narrows within that.
      const clamp = await resolveBranchClamp(req.user!);
      const clampSql = agentBranchClamp(clamp, params, "u");
      if (clampSql) filters.push(clampSql.replace(/^ AND /, ""));
      if (q.agent_id) {
        params.push(q.agent_id);
        filters.push(`r.agent_id = $${params.length}`);
      }
    }

    const { rows } = await pool.query(
      `SELECT r.id, r.customer_id, r.agent_id, r.remind_at, r.note, r.status, r.created_at,
              c.customer_name, c.loan_number,
              u.full_name AS agent_name
         FROM reminders r
         LEFT JOIN customers c ON c.id = r.customer_id
         JOIN users u ON u.id = r.agent_id
        WHERE r.agency_id = $1
          ${filters.map((f) => `AND ${f}`).join("\n          ")}
        ORDER BY r.remind_at ASC`,
      params,
    );
    res.json({ reminders: rows, total: rows.length });
  }),
);

const patchSchema = z.object({ status: z.enum(["done", "cancelled"]) });

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const seesAll = await capabilitiesHavePermission(
      capabilitiesOf(req.user!),
      "customers.allocate",
    );

    const params: unknown[] = [req.params.id, req.user!.agency_id];
    let ownerClause = "";
    if (!seesAll) {
      params.push(req.user!.id);
      ownerClause = `AND agent_id = $${params.length}`;
    } else {
      // No `users` join in this query to hang agentBranchClamp() off of --
      // same branch check as a self-contained EXISTS instead.
      const clamp = await resolveBranchClamp(req.user!);
      if (clamp) {
        params.push(clamp.branchId);
        const n = params.length;
        ownerClause = `AND EXISTS (SELECT 1 FROM users ru WHERE ru.id = agent_id AND (ru.branch_id = $${n} OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = ru.id AND tb.branch_id = $${n})))`;
      }
    }

    const { rows } = await pool.query(
      `UPDATE reminders SET status = $${params.length + 1}
        WHERE id = $1 AND agency_id = $2 ${ownerClause}
        RETURNING *`,
      [...params, body.status],
    );
    if (!rows[0]) throw new HttpError(404, "Reminder not found");
    res.json({ reminder: rows[0] });
  }),
);

export default router;
