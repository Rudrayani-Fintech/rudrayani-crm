import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { scopeFilter } from "../services/scope";

const router = Router();
router.use(authenticate, requirePermission("tracking.view"));

const IST = "Asia/Kolkata";

/**
 * Paginated flat attendance record list for admin/ops/TL (tracking.view).
 * Each row is one punch-in/out shift. Scope: admin/ops see all, TL sees own team.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const me = req.user!;
    const q = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        branch_id: z.string().uuid().optional(),
        team_id: z.string().uuid().optional(),
        agent_id: z.string().uuid().optional(),
        on_duty_only: z
          .union([z.literal("true"), z.literal("false")])
          .optional()
          .transform((v) => v === "true"),
        page: z.coerce.number().int().min(1).default(1),
        per_page: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const scope = await scopeFilter(me);
    const params: unknown[] = [me.agency_id];
    let scopeClause = "";
    if (scope.param !== null) {
      params.push(scope.param);
      scopeClause = scope.clause.replaceAll("$SCOPE", `$${params.length}`);
    }

    let extraClause = "";
    if (q.from) {
      params.push(q.from);
      extraClause += ` AND a.punch_in_at >= ($${params.length}::date::timestamp AT TIME ZONE '${IST}')`;
    }
    if (q.to) {
      params.push(q.to);
      extraClause += ` AND a.punch_in_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE '${IST}')`;
    }
    if (q.branch_id) {
      params.push(q.branch_id);
      extraClause += ` AND u.branch_id = $${params.length}`;
    }
    if (q.team_id) {
      params.push(q.team_id);
      extraClause += ` AND u.team_id = $${params.length}`;
    }
    if (q.agent_id) {
      params.push(q.agent_id);
      extraClause += ` AND u.id = $${params.length}`;
    }
    if (q.on_duty_only) {
      extraClause += ` AND a.punch_out_at IS NULL`;
    }

    // Taken before per_page/offset are appended below, so these placeholder
    // numbers line up with the ones already baked into scopeClause/extraClause.
    const countParams = [...params];

    const offset = (q.page - 1) * q.per_page;
    params.push(q.per_page, offset);
    const limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

    // Without this, the client had no way to know how many rows exist past
    // the current page -- AntD's Table sized its pagination off
    // dataSource.length alone, so page 2 was unreachable no matter how many
    // records the server actually had.
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
         FROM attendance a
         JOIN users u ON u.id = a.user_id
        WHERE u.agency_id = $1
          ${scopeClause}
          ${extraClause}`,
      countParams,
    );
    const total = Number(countRows[0]?.count ?? 0);

    const { rows } = await pool.query(
      `SELECT a.id,
              u.id AS user_id, u.full_name,
              t.name AS team_name, b.name AS branch_name,
              a.punch_in_at,
              a.punch_out_at,
              ST_Y(a.punch_in_location::geometry)  AS punch_in_lat,
              ST_X(a.punch_in_location::geometry)  AS punch_in_lng,
              ST_Y(a.punch_out_location::geometry) AS punch_out_lat,
              ST_X(a.punch_out_location::geometry) AS punch_out_lng,
              EXTRACT(EPOCH FROM (COALESCE(a.punch_out_at, now()) - a.punch_in_at))::int AS duration_seconds
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.agency_id = $1
          ${scopeClause}
          ${extraClause}
        ORDER BY a.punch_in_at DESC
        ${limitClause}`,
      params,
    );

    res.json({ records: rows, page: q.page, per_page: q.per_page, total });
  }),
);

export default router;
