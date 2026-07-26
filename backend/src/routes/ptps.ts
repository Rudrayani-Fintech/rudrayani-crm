import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { capabilitiesOf } from "../types/user";
import { capabilitiesHavePermission } from "../services/permission-service";
import { agentBranchClamp, resolveBranchClamp } from "../services/scope";
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

    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.promised_date, p.mode, p.status, p.created_at,
              c.id AS customer_id, c.loan_number, c.customer_name,
              p.agent_id, u.full_name AS agent_name
         FROM ptps p
         JOIN customers c ON c.id = p.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = p.agent_id
        WHERE co.agency_id = $1
          ${filters.map((f) => `AND ${f}`).join("\n          ")}
        ORDER BY p.created_at DESC
        LIMIT 100`,
      params,
    );
    res.json({ ptps: rows, total: rows.length });
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

export default router;
