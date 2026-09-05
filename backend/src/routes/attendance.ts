import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { HttpError } from "../middleware/error-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";

const router = Router();
router.use(authenticate, requirePermission("attendance.punch"));

// lat/lng are optional -- `attendance.punch_in_location`/`punch_out_location`
// were always nullable at the DB level (baseline-init.sql), but this schema
// and the unconditional ST_MakePoint() below forced a GPS fix before an
// agent could punch in or out at all. A failed fix (indoors, GPS cold-start,
// permission just granted) meant the app was completely unusable at both
// ends of a shift. Recording "no fix available" is strictly better than
// blocking -- and better than a bogus (0,0) point, which would misrepresent
// the agent's real location on any route/map view.
const gpsSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

const punchOutSchema = gpsSchema.extend({
  // Phase 6 (§4.5): punch-out targets the currently open shift
  // (punch_out_at IS NULL) -- a retry after the first success would find no
  // open shift and 409 instead of returning the original result. Needs its
  // own column (not attendance's other client_key-shaped state, since a
  // shift's punch-in has none of its own to reuse).
  client_key: z.string().uuid().optional(),
});

const POINT_OR_NULL = `CASE WHEN $2::float8 IS NOT NULL AND $3::float8 IS NOT NULL
  THEN ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)::geography
  ELSE NULL END`;

/**
 * Punch in — opens the shift and starts the tracking session (brief Section 10:
 * "punch-in starts the location-tracking session ... explicit in the UI").
 * The partial unique index uq_attendance_open_shift backstops the 409.
 */
router.post(
  "/punch-in",
  asyncHandler(async (req, res) => {
    const { lat, lng } = gpsSchema.parse(req.body);

    const open = await pool.query(
      "SELECT id FROM attendance WHERE user_id = $1 AND punch_out_at IS NULL",
      [req.user!.id],
    );
    if (open.rows.length > 0) throw new HttpError(409, "Already punched in");

    const { rows } = await pool.query(
      `INSERT INTO attendance (user_id, punch_in_at, punch_in_location)
       VALUES ($1, now(), ${POINT_OR_NULL})
       RETURNING id, punch_in_at`,
      [req.user!.id, lng ?? null, lat ?? null],
    );
    res.status(201).json({ attendance: rows[0] });
  }),
);

/** Punch out — closes the open shift and ends the tracking session. */
router.post(
  "/punch-out",
  asyncHandler(async (req, res) => {
    const { lat, lng, client_key } = punchOutSchema.parse(req.body);

    if (client_key) {
      const dup = await pool.query(
        "SELECT id, punch_in_at, punch_out_at FROM attendance WHERE user_id = $1 AND punch_out_client_key = $2",
        [req.user!.id, client_key],
      );
      if (dup.rows[0]) {
        res.json({ attendance: dup.rows[0], duplicate: true });
        return;
      }
    }

    const { rows } = await pool.query(
      `UPDATE attendance
          SET punch_out_at = now(),
              punch_out_location = ${POINT_OR_NULL},
              punch_out_client_key = $4
        WHERE user_id = $1 AND punch_out_at IS NULL
        RETURNING id, punch_in_at, punch_out_at`,
      [req.user!.id, lng ?? null, lat ?? null, client_key ?? null],
    );
    if (rows.length === 0) throw new HttpError(409, "Not punched in");
    res.json({ attendance: rows[0] });
  }),
);

/**
 * Current shift state — the app calls this on startup so a restarted phone
 * resumes (or stops) tracking to match the server's view of the shift.
 */
router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, punch_in_at FROM attendance WHERE user_id = $1 AND punch_out_at IS NULL",
      [req.user!.id],
    );
    res.json({ punched_in: rows.length > 0, attendance: rows[0] ?? null });
  }),
);

export default router;
