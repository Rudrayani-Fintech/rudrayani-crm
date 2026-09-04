import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";

const router = Router();
router.use(authenticate);

// GET is open to anyone authenticated (agents need codes for call logging in Phase 3)
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.include_inactive === "true";
    const { rows } = await pool.query(
      `SELECT id, action_code, category, result_code, description, remark_template,
              needs_amount, needs_date, needs_time, needs_mode, needs_reason,
              needs_name_relation, is_active, channel,
              followup_after_hours, exits_agent_queue, routes_to
         FROM disposition_codes
        WHERE agency_id = $1
          ${includeInactive ? "" : "AND is_active = true"}
        ORDER BY action_code, COALESCE(result_code, ''), description`,
      [req.user!.agency_id],
    );
    res.json({ disposition_codes: rows });
  }),
);

const dispositionBody = z.object({
  action_code: z.string().trim().min(1).max(20),
  category: z.string().trim().min(1).max(100).nullable().optional(),
  result_code: z.string().trim().min(1).max(20).nullable().optional(),
  description: z.string().trim().min(1).max(200),
  remark_template: z.string().trim().nullable().optional(),
  channel: z.enum(["FV", "OC"]),
  needs_amount: z.boolean().default(false),
  needs_date: z.boolean().default(false),
  needs_time: z.boolean().default(false),
  needs_mode: z.boolean().default(false),
  needs_reason: z.boolean().default(false),
  needs_name_relation: z.boolean().default(false),
  // Phase 4 (§4.2): disposition cadence. followup_after_hours is nullable
  // (NULL = no automatic follow-up, e.g. Promise to Pay/Call Back already
  // resurface via their own date). routes_to is only meaningful alongside
  // exits_agent_queue = true, but isn't required to be -- an admin may set
  // it ahead of flipping the flag.
  followup_after_hours: z.number().int().positive().nullable().optional(),
  exits_agent_queue: z.boolean().default(false),
  routes_to: z.enum(["field", "manager", "data_correction", "closed"]).nullable().optional(),
});

router.post(
  "/",
  requirePermission("dispositions.manage"),
  asyncHandler(async (req, res) => {
    const body = dispositionBody.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO disposition_codes
         (agency_id, action_code, category, result_code, description, remark_template, channel,
          needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation,
          followup_after_hours, exits_agent_queue, routes_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        req.user!.agency_id,
        body.action_code,
        body.category ?? null,
        body.result_code ?? null,
        body.description,
        body.remark_template ?? null,
        body.channel,
        body.needs_amount,
        body.needs_date,
        body.needs_time,
        body.needs_mode,
        body.needs_reason,
        body.needs_name_relation,
        body.followup_after_hours ?? null,
        body.exits_agent_queue,
        body.routes_to ?? null,
      ],
    );
    res.status(201).json({ disposition_code: rows[0] });
  }),
);

const patchBody = dispositionBody.partial().extend({
  is_active: z.boolean().optional(),
});

router.patch(
  "/:id",
  requirePermission("dispositions.manage"),
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = patchBody.parse(req.body);

    const check = await pool.query(
      "SELECT id FROM disposition_codes WHERE id = $1 AND agency_id = $2",
      [id, req.user!.agency_id],
    );
    if (check.rows.length === 0) throw new HttpError(404, "Disposition code not found");

    const sets: string[] = [];
    const params: unknown[] = [id, req.user!.agency_id];
    const updatable = body as Record<string, unknown>;

    for (const field of [
      "action_code",
      "category",
      "result_code",
      "description",
      "remark_template",
      "channel",
      "needs_amount",
      "needs_date",
      "needs_time",
      "needs_mode",
      "needs_reason",
      "needs_name_relation",
      "is_active",
      "followup_after_hours",
      "exits_agent_queue",
      "routes_to",
    ]) {
      if (updatable[field] !== undefined) {
        params.push(updatable[field]);
        sets.push(`${field} = $${params.length}`);
      }
    }

    if (sets.length === 0) throw new HttpError(400, "Nothing to update");

    const { rows } = await pool.query(
      `UPDATE disposition_codes SET ${sets.join(", ")}
        WHERE id = $1 AND agency_id = $2 RETURNING *`,
      params,
    );
    res.json({ disposition_code: rows[0] });
  }),
);

export default router;
