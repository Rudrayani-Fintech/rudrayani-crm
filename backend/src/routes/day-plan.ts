import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { scopeFilter } from "../services/scope";
import { istToday } from "../utils/ist";

const router = Router();
router.use(authenticate, requirePermission("tracking.view"));

const IST = "Asia/Kolkata";

/**
 * Per-agent "what's due today" summary for admin/ops/TL (Group C): the
 * agency-owner view of who's on duty and what they still have to chase.
 * Same visibility scope as /tracking (agency-wide for admin/ops, own team
 * for a TL) and the same IST-day LATERAL-join pattern as /tracking/team-day.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const me = req.user!;
    const q = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        branch_id: z.string().uuid().optional(),
        team_id: z.string().uuid().optional(),
      })
      .parse(req.query);
    const date = q.date ?? istToday();

    const scope = await scopeFilter(me);
    const params: unknown[] = [me.agency_id, date];
    let scopeClause = "";
    if (scope.param !== null) {
      params.push(scope.param);
      scopeClause = scope.clause.replaceAll("$SCOPE", `$${params.length}`);
    }
    let extraClause = "";
    if (q.branch_id) {
      params.push(q.branch_id);
      extraClause += ` AND u.branch_id = $${params.length}`;
    }
    if (q.team_id) {
      params.push(q.team_id);
      extraClause += ` AND u.team_id = $${params.length}`;
    }

    const dayStart = `($2::date::timestamp AT TIME ZONE '${IST}')`;
    const dayEnd = `(($2::date + 1)::timestamp AT TIME ZONE '${IST}')`;

    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.full_name, u.is_field_agent, u.is_telecaller,
              t.name AS team_name, b.name AS branch_name,
              att.first_in, att.last_out, att.on_duty,
              COALESCE(ptps.n, 0) AS ptps_due_count,
              COALESCE(ptps.total, 0) AS ptps_due_total,
              COALESCE(rem.n, 0) AS reminders_due_count,
              COALESCE(acts.calls, 0) AS calls,
              COALESCE(pays.n, 0) AS payments_count,
              COALESCE(pays.total, 0) AS payments_total
         FROM users u
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN branches b ON b.id = u.branch_id
         LEFT JOIN LATERAL (
              SELECT min(punch_in_at) AS first_in,
                     max(punch_out_at) AS last_out,
                     bool_or(punch_out_at IS NULL) AS on_duty
                FROM attendance
               WHERE user_id = u.id
                 AND punch_in_at >= ${dayStart} AND punch_in_at < ${dayEnd}
         ) att ON true
         LEFT JOIN LATERAL (
              SELECT count(*)::int AS n, COALESCE(sum(amount), 0) AS total
                FROM ptps p
               WHERE p.agent_id = u.id AND p.status = 'pending' AND p.promised_date <= $2
         ) ptps ON true
         LEFT JOIN LATERAL (
              SELECT count(*)::int AS n
                FROM reminders r
               WHERE r.agent_id = u.id AND r.status = 'pending'
                 AND r.remind_at >= ${dayStart} AND r.remind_at < ${dayEnd}
         ) rem ON true
         LEFT JOIN LATERAL (
              SELECT count(*)::int AS calls
                FROM call_logs cl
               WHERE cl.agent_id = u.id
                 AND cl.created_at >= ${dayStart} AND cl.created_at < ${dayEnd}
         ) acts ON true
         LEFT JOIN LATERAL (
              SELECT count(*)::int AS n, COALESCE(sum(amount), 0) AS total
                FROM payments
               WHERE collected_by_user_id = u.id
                 AND created_at >= ${dayStart} AND created_at < ${dayEnd}
         ) pays ON true
        WHERE u.agency_id = $1 AND u.is_active = true
          ${scopeClause}
          ${extraClause}
        ORDER BY u.full_name`,
      params,
    );

    res.json({
      date,
      agents: rows.map((r) => ({
        user_id: r.user_id,
        full_name: r.full_name,
        is_field_agent: r.is_field_agent,
        is_telecaller: r.is_telecaller,
        team_name: r.team_name,
        branch_name: r.branch_name,
        attendance: {
          first_in: r.first_in,
          last_out: r.last_out,
          on_duty: r.on_duty === true,
        },
        ptps_due: { count: r.ptps_due_count, total_amount: Number(r.ptps_due_total) },
        reminders_due: { count: r.reminders_due_count },
        activity: {
          calls: r.calls,
          payments_count: r.payments_count,
          payments_total: Number(r.payments_total),
        },
      })),
    });
  }),
);

/**
 * Customer-level expansion for one agent's day: the actual PTPs and
 * reminders behind the summary counts above.
 */
router.get(
  "/agent/:id",
  asyncHandler(async (req, res) => {
    const me = req.user!;
    const q = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.query);
    const date = q.date ?? istToday();

    const scope = await scopeFilter(me);
    const targetParams: unknown[] = [req.params.id, me.agency_id];
    let scopeClause = "";
    if (scope.param !== null) {
      targetParams.push(scope.param);
      scopeClause = scope.clause.replaceAll("$SCOPE", `$${targetParams.length}`);
    }
    const target = await pool.query(
      `SELECT u.id FROM users u WHERE u.id = $1 AND u.agency_id = $2 ${scopeClause}`,
      targetParams,
    );
    if (target.rows.length === 0) throw new HttpError(404, "Agent not found in your scope");

    const dayStart = `($2::date::timestamp AT TIME ZONE '${IST}')`;
    const dayEnd = `(($2::date + 1)::timestamp AT TIME ZONE '${IST}')`;

    const ptps = await pool.query(
      `SELECT p.id, c.id AS customer_id, c.customer_name, c.loan_number, p.amount, p.promised_date
         FROM ptps p
         JOIN customers c ON c.id = p.customer_id
        WHERE p.agent_id = $1 AND p.status = 'pending' AND p.promised_date <= $2
        ORDER BY p.promised_date ASC`,
      [req.params.id, date],
    );

    const reminders = await pool.query(
      `SELECT r.id, r.customer_id, c.customer_name, c.loan_number, r.remind_at, r.note
         FROM reminders r
         LEFT JOIN customers c ON c.id = r.customer_id
        WHERE r.agent_id = $1 AND r.status = 'pending'
          AND r.remind_at >= ${dayStart} AND r.remind_at < ${dayEnd}
        ORDER BY r.remind_at ASC`,
      [req.params.id, date],
    );

    res.json({ date, ptps: ptps.rows, reminders: reminders.rows });
  }),
);

export default router;
