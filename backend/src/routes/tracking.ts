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

// "Single location for more than 20 minutes" alert. Radius absorbs normal
// GPS jitter (~10-50m); both are overridable per agency via agencies.settings.
const STATIONARY_MINUTES_DEFAULT = 20;
const STATIONARY_RADIUS_M_DEFAULT = 100;
// Last ping older than this while on duty → the phone stopped reporting
// (killed app, GPS off, dead battery) — that's a different alert than
// "stationary", the manager can't trust the shown position.
const NO_SIGNAL_MINUTES = 10;

const IST = "Asia/Kolkata";

async function agencyThresholds(agencyId: string): Promise<{ minutes: number; radius: number }> {
  const { rows } = await pool.query(
    `SELECT settings->>'stationary_alert_minutes' AS m,
            settings->>'stationary_radius_meters' AS r
       FROM agencies WHERE id = $1`,
    [agencyId],
  );
  const m = Number(rows[0]?.m);
  const r = Number(rows[0]?.r);
  return {
    minutes: Number.isFinite(m) && m > 0 ? m : STATIONARY_MINUTES_DEFAULT,
    radius: Number.isFinite(r) && r > 0 ? r : STATIONARY_RADIUS_M_DEFAULT,
  };
}

/**
 * Live team map: every on-duty user in scope with their latest ping and a
 * status the manager can act on:
 *  - awaiting_first_ping — punched in, no ping yet
 *  - no_signal           — last ping too old to trust
 *  - stationary          — inside <radius>m of the current spot for >= <minutes>
 *  - moving              — everything else
 * stationary_since is the first ping of the current dwell (may predate the
 * threshold window), so the UI can show "stationary for 47 min".
 */
router.get(
  "/live",
  asyncHandler(async (req, res) => {
    const me = req.user!;
    const scope = await scopeFilter(me);
    const { minutes, radius } = await agencyThresholds(me.agency_id);

    const params: unknown[] = [me.agency_id, radius];
    let scopeClause = "";
    if (scope.param !== null) {
      params.push(scope.param);
      scopeClause = scope.clause.replaceAll("$SCOPE", `$${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.full_name, u.phone, u.is_field_agent,
              u.team_id, t.name AS team_name, b.name AS branch_name,
              a.punch_in_at,
              lp.recorded_at AS last_ping_at,
              ST_Y(lp.location::geometry) AS lat,
              ST_X(lp.location::geometry) AS lng,
              lp.accuracy_meters,
              dwell.since AS stationary_since
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN branches b ON b.id = u.branch_id
         LEFT JOIN LATERAL (
              SELECT location, recorded_at, accuracy_meters
                FROM location_pings
               WHERE user_id = u.id AND recorded_at >= a.punch_in_at
               ORDER BY recorded_at DESC LIMIT 1
         ) lp ON true
         LEFT JOIN LATERAL (
              -- First ping of the current dwell: everything after the last
              -- ping that was outside <radius>m of the current position.
              SELECT min(p.recorded_at) AS since
                FROM location_pings p
               WHERE p.user_id = u.id
                 AND p.recorded_at >= a.punch_in_at
                 AND p.recorded_at > COALESCE(
                       (SELECT max(q.recorded_at)
                          FROM location_pings q
                         WHERE q.user_id = u.id
                           AND q.recorded_at >= a.punch_in_at
                           AND ST_Distance(q.location, lp.location) > $2),
                       '-infinity'::timestamptz)
         ) dwell ON lp.location IS NOT NULL
        WHERE a.punch_out_at IS NULL
          AND u.agency_id = $1
          ${scopeClause}
        ORDER BY u.full_name`,
      params,
    );

    const now = Date.now();
    const agents = rows.map((r) => {
      let status: string;
      let stationaryMinutes: number | null = null;
      if (!r.last_ping_at) {
        status = "awaiting_first_ping";
      } else if (now - new Date(r.last_ping_at).getTime() > NO_SIGNAL_MINUTES * 60_000) {
        status = "no_signal";
      } else {
        // "Not moving" only means something for field agents — a telecaller
        // works a desk all day and would alert permanently.
        const dwellMin =
          r.is_field_agent && r.stationary_since
            ? (now - new Date(r.stationary_since).getTime()) / 60_000
            : 0;
        if (dwellMin >= minutes) {
          status = "stationary";
          stationaryMinutes = Math.floor(dwellMin);
        } else {
          status = "moving";
        }
      }
      return {
        user_id: r.user_id,
        full_name: r.full_name,
        phone: r.phone,
        team_id: r.team_id,
        team_name: r.team_name,
        branch_name: r.branch_name,
        punch_in_at: r.punch_in_at,
        last_ping_at: r.last_ping_at,
        lat: r.lat !== null ? Number(r.lat) : null,
        lng: r.lng !== null ? Number(r.lng) : null,
        accuracy_meters: r.accuracy_meters !== null ? Number(r.accuracy_meters) : null,
        status,
        stationary_since: status === "stationary" ? r.stationary_since : null,
        stationary_minutes: stationaryMinutes,
      };
    });

    res.json({
      agents,
      alerts: agents.filter((a) => a.status === "stationary" || a.status === "no_signal"),
      thresholds: { stationary_minutes: minutes, stationary_radius_meters: radius },
    });
  }),
);

/**
 * Route replay: one user's pings for one calendar day (IST), ordered, plus
 * that day's shifts and the total path length. Within the 60-day retention
 * window; older dates simply return no points.
 */
router.get(
  "/route",
  asyncHandler(async (req, res) => {
    const me = req.user!;
    const q = z
      .object({
        user_id: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.query);

    const scope = await scopeFilter(me);
    const targetParams: unknown[] = [q.user_id, me.agency_id];
    let scopeClause = "";
    if (scope.param !== null) {
      targetParams.push(scope.param);
      scopeClause = scope.clause.replaceAll("$SCOPE", `$${targetParams.length}`);
    }
    const target = await pool.query(
      `SELECT u.id, u.full_name FROM users u
        WHERE u.id = $1 AND u.agency_id = $2 ${scopeClause}`,
      targetParams,
    );
    if (target.rows.length === 0) throw new HttpError(404, "User not found in your scope");

    // Day boundaries interpreted in IST, not server timezone.
    const dayWindow = `($2::date::timestamp AT TIME ZONE '${IST}')
                   AND recorded_at < (($2::date + 1)::timestamp AT TIME ZONE '${IST}')`;

    const points = await pool.query(
      `SELECT recorded_at,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lng,
              accuracy_meters
         FROM location_pings
        WHERE user_id = $1
          AND recorded_at >= ${dayWindow}
        ORDER BY recorded_at ASC`,
      [q.user_id, q.date],
    );

    const distance = await pool.query(
      `SELECT COALESCE(ST_Length(ST_MakeLine(location::geometry ORDER BY recorded_at)::geography), 0) AS meters
         FROM location_pings
        WHERE user_id = $1
          AND recorded_at >= ${dayWindow}`,
      [q.user_id, q.date],
    );

    const shifts = await pool.query(
      `SELECT punch_in_at, punch_out_at,
              ST_Y(punch_in_location::geometry) AS in_lat,
              ST_X(punch_in_location::geometry) AS in_lng,
              ST_Y(punch_out_location::geometry) AS out_lat,
              ST_X(punch_out_location::geometry) AS out_lng
         FROM attendance
        WHERE user_id = $1
          AND punch_in_at >= ($2::date::timestamp AT TIME ZONE '${IST}')
          AND punch_in_at < (($2::date + 1)::timestamp AT TIME ZONE '${IST}')
        ORDER BY punch_in_at ASC`,
      [q.user_id, q.date],
    );

    res.json({
      user: target.rows[0],
      date: q.date,
      points: points.rows.map((p) => ({
        recorded_at: p.recorded_at,
        lat: Number(p.lat),
        lng: Number(p.lng),
        accuracy_meters: p.accuracy_meters !== null ? Number(p.accuracy_meters) : null,
      })),
      distance_meters: Math.round(Number(distance.rows[0].meters)),
      shifts: shifts.rows,
    });
  }),
);

/**
 * Team day view for the TL mobile screen (brief §8: attendance + team
 * performance): every user in scope with that day's shifts, worked minutes,
 * and activity counts (calls, payments, PTPs). Same IST day boundaries and
 * visibility scope as the rest of tracking.
 */
router.get(
  "/team-day",
  asyncHandler(async (req, res) => {
    const me = req.user!;
    const q = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.query);
    const date = q.date ?? istToday();

    const scope = await scopeFilter(me);
    const params: unknown[] = [me.agency_id, date];
    let scopeClause = "";
    if (scope.param !== null) {
      params.push(scope.param);
      scopeClause = scope.clause.replaceAll("$SCOPE", `$${params.length}`);
    }

    const dayStart = `($2::date::timestamp AT TIME ZONE '${IST}')`;
    const dayEnd = `(($2::date + 1)::timestamp AT TIME ZONE '${IST}')`;

    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.full_name, u.is_field_agent, u.is_telecaller,
              t.name AS team_name,
              att.first_in, att.last_out, att.on_duty, att.minutes_worked,
              COALESCE(acts.calls, 0) AS calls,
              COALESCE(acts.ptps, 0) AS ptps,
              COALESCE(pays.n, 0) AS payments_count,
              COALESCE(pays.total, 0) AS payments_total,
              COALESCE(pays.cash_total, 0) AS cash_total,
              COALESCE(pays.online_total, 0) AS online_total,
              COALESCE(visits.n, 0) AS field_visits,
              COALESCE(visits.with_photo, 0) AS field_visits_with_photo,
              COALESCE(visits.with_signature, 0) AS field_visits_with_signature
         FROM users u
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN LATERAL (
              SELECT min(punch_in_at) AS first_in,
                     max(punch_out_at) AS last_out,
                     bool_or(punch_out_at IS NULL) AS on_duty,
                     COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(punch_out_at, now()) - punch_in_at)) / 60), 0)::int AS minutes_worked
                FROM attendance
               WHERE user_id = u.id
                 AND punch_in_at >= ${dayStart} AND punch_in_at < ${dayEnd}
         ) att ON true
         LEFT JOIN LATERAL (
              SELECT count(*)::int AS calls,
                     count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ptps p WHERE p.call_log_id = cl.id))::int AS ptps
                FROM call_logs cl
               WHERE cl.agent_id = u.id
                 AND cl.created_at >= ${dayStart} AND cl.created_at < ${dayEnd}
         ) acts ON true
         LEFT JOIN LATERAL (
              -- Cash/Online Collections KPI (Team Leader dashboard, Phase 12):
              -- "Cash" is the literal mode value; every other non-null mode
              -- (NEFT/RTGS/UPI/Cheque/DD) is bucketed as "online".
              SELECT count(*)::int AS n, COALESCE(sum(amount), 0) AS total,
                     COALESCE(sum(amount) FILTER (WHERE lower(mode) = 'cash'), 0) AS cash_total,
                     COALESCE(sum(amount) FILTER (WHERE mode IS NOT NULL AND lower(mode) <> 'cash'), 0) AS online_total
                FROM payments
               WHERE collected_by_user_id = u.id
                 AND created_at >= ${dayStart} AND created_at < ${dayEnd}
         ) pays ON true
         LEFT JOIN LATERAL (
              -- Receipts Generated / Documents Uploaded KPI (Team Leader +
              -- Field Executive dashboards, Phase 12): field_visits has no
              -- boolean has_photo/has_signature column, only the URL itself.
              SELECT count(*)::int AS n,
                     count(*) FILTER (WHERE photo_url IS NOT NULL)::int AS with_photo,
                     count(*) FILTER (WHERE signature_url IS NOT NULL)::int AS with_signature
                FROM field_visits
               WHERE agent_id = u.id
                 AND created_at >= ${dayStart} AND created_at < ${dayEnd}
         ) visits ON true
        WHERE u.agency_id = $1 AND u.is_active = true
          ${scopeClause}
        ORDER BY u.full_name`,
      params,
    );

    res.json({
      date,
      members: rows.map((r) => ({
        ...r,
        payments_total: Number(r.payments_total),
        cash_total: Number(r.cash_total),
        online_total: Number(r.online_total),
        on_duty: r.on_duty === true,
      })),
    });
  }),
);

export default router;
