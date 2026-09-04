import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import {
  composeRemark,
  createsPtp,
  missingRequiredFields,
  type DispositionCodeRow,
  type DispositionFields,
} from "../services/disposition-service";
import { refreshNextActionDate } from "../services/ptp-service";
import { customerWriteScopeClamp } from "../services/scope";

const router = Router();
router.use(authenticate, requirePermission("calls.log"));

const fieldsSchema = z.object({
  amount: z.coerce.number().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  time: z.string().trim().min(1).max(20).optional(),
  mode: z.string().trim().min(1).max(60).optional(),
  reason: z.string().trim().min(1).max(300).optional(),
  name_relation: z.string().trim().min(1).max(120).optional(),
});

const logBody = z.object({
  customer_id: z.string().uuid(),
  disposition_code_id: z.string().uuid(),
  fields: fieldsSchema.default({}),
  call_duration_seconds: z.coerce.number().int().min(0).max(24 * 3600).optional(),
  extra_remark: z.string().trim().max(500).optional(), // free text appended after the composed remark
  client_key: z.string().uuid().optional(), // offline-sync idempotency key
});

/** Look up a call log previously created with this idempotency key. */
async function findByClientKey(agentId: string, clientKey: string) {
  const existing = await pool.query(
    "SELECT * FROM call_logs WHERE agent_id = $1 AND client_key = $2",
    [agentId, clientKey],
  );
  if (!existing.rows[0]) return null;
  const ptp = await pool.query("SELECT * FROM ptps WHERE call_log_id = $1", [existing.rows[0].id]);
  return { call_log: existing.rows[0], ptp: ptp.rows[0] ?? null, duplicate: true };
}

/**
 * Log a call/visit disposition (build brief Sections 7-8): server validates the
 * structured fields demanded by the code's needs_* flags, composes the final
 * remark from the template, and opens a PTP record for promise-type codes.
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = logBody.parse(req.body);
    const agencyId = req.user!.agency_id;

    if (body.client_key) {
      const dup = await findByClientKey(req.user!.id, body.client_key);
      if (dup) {
        res.status(200).json(dup);
        return;
      }
    }

    // Previously checked only agency_id -- any authenticated user with
    // calls.log could log against any customer in the agency. Clamp to
    // customers actually assigned to the caller (or, for a branch_manager,
    // to their branch).
    const params: unknown[] = [body.customer_id, agencyId];
    const scopeClause = await customerWriteScopeClamp(req.user!, params, "c");
    const custRes = await pool.query(
      `SELECT c.id, c.assigned_agent_id FROM customers c
         JOIN companies co ON co.id = c.company_id
        WHERE c.id = $1 AND co.agency_id = $2 AND c.status = 'active' ${scopeClause}`,
      params,
    );
    if (!custRes.rows[0]) throw new HttpError(404, "Customer not found or already closed");

    const codeRes = await pool.query<DispositionCodeRow>(
      `SELECT * FROM disposition_codes
        WHERE id = $1 AND agency_id = $2 AND is_active = true`,
      [body.disposition_code_id, agencyId],
    );
    const code = codeRes.rows[0];
    if (!code) throw new HttpError(404, "Disposition code not found or retired");

    const missing = missingRequiredFields(code, body.fields);
    if (missing.length > 0) {
      throw new HttpError(400, `This disposition requires: ${missing.join(", ")}`);
    }

    const composed = composeRemark(code, body.fields);
    const remark = body.extra_remark ? `${composed} — ${body.extra_remark}` : composed;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const callLog = await client.query(
        `INSERT INTO call_logs (customer_id, agent_id, disposition_code_id, remark, extra_remark, call_duration_seconds, details, client_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          body.customer_id,
          req.user!.id,
          code.id,
          remark,
          body.extra_remark ?? null,
          body.call_duration_seconds ?? null,
          JSON.stringify(body.fields),
          body.client_key ?? null,
        ],
      );

      let ptp = null;
      if (createsPtp(code)) {
        const ptpRes = await client.query(
          `INSERT INTO ptps (customer_id, call_log_id, agent_id, amount, promised_date, mode)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            body.customer_id,
            callLog.rows[0].id,
            req.user!.id,
            body.fields.amount,
            body.fields.date,
            body.fields.mode ?? null,
          ],
        );
        ptp = ptpRes.rows[0];
      }
      // Phase 4 (§4.2): every call log can move next_action_date, not just
      // PTP-creating ones -- this is the disposition-cadence engine's only
      // hook. A fresh PTP's promised_date wins over the code's own cadence
      // (refreshNextActionDate takes the MIN across all three sources), so
      // calling this unconditionally is correct either way.
      await refreshNextActionDate(client, body.customer_id);

      await client.query("COMMIT");
      res.status(201).json({ call_log: callLog.rows[0], ptp });
    } catch (err) {
      await client.query("ROLLBACK");
      // Two retries raced: the other one won, answer with its row.
      if (
        body.client_key &&
        err instanceof Error &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        const dup = await findByClientKey(req.user!.id, body.client_key);
        if (dup) {
          res.status(200).json(dup);
          return;
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }),
);

/** Call history for a customer (newest first). */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const customerId = z.string().uuid().parse(req.query.customer_id);
    const { rows } = await pool.query(
      `SELECT cl.id, cl.remark, cl.call_duration_seconds, cl.details, cl.created_at,
              u.full_name AS agent_name,
              d.action_code, d.result_code, d.description AS disposition_description
         FROM call_logs cl
         JOIN customers c ON c.id = cl.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = cl.agent_id
         LEFT JOIN disposition_codes d ON d.id = cl.disposition_code_id
        WHERE cl.customer_id = $1 AND co.agency_id = $2
        ORDER BY cl.created_at DESC
        LIMIT 200`,
      [customerId, req.user!.agency_id],
    );
    res.json({ call_logs: rows });
  }),
);

const editRemarkBody = z.object({
  extra_remark: z.string().trim().max(500),
});

/**
 * Same-day self-edit (MVP hardening): within 24h of logging it, the agent
 * who created the call log can fix a typo/omission in the free-text tail
 * without a TL approval round-trip. Only extra_remark is touched -- the
 * disposition code and structured `details` are re-read as-is and fed back
 * through composeRemark() so the template-driven portion of `remark` can
 * never drift from what missingRequiredFields()/createsPtp() validated at
 * creation time. After 24h, correction-requests.ts is the only path left.
 */
router.patch(
  "/:id/remark",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = editRemarkBody.parse(req.body);

    const { rows } = await pool.query(
      `SELECT cl.id, cl.disposition_code_id, cl.details, cl.created_at
         FROM call_logs cl
         JOIN customers c ON c.id = cl.customer_id
         JOIN companies co ON co.id = c.company_id
        WHERE cl.id = $1 AND co.agency_id = $2 AND cl.agent_id = $3`,
      [id, req.user!.agency_id, req.user!.id],
    );
    const callLog = rows[0];
    if (!callLog) throw new HttpError(404, "Call log not found, or it isn't yours");

    const ageMs = Date.now() - new Date(callLog.created_at).getTime();
    if (ageMs >= 24 * 3600 * 1000) {
      throw new HttpError(409, "This call log is more than 24 hours old — submit a correction request instead");
    }

    let composed = "";
    if (callLog.disposition_code_id) {
      const codeRes = await pool.query<DispositionCodeRow>("SELECT * FROM disposition_codes WHERE id = $1", [
        callLog.disposition_code_id,
      ]);
      if (codeRes.rows[0]) {
        composed = composeRemark(codeRes.rows[0], (callLog.details ?? {}) as DispositionFields);
      }
    }
    const remark = body.extra_remark ? (composed ? `${composed} — ${body.extra_remark}` : body.extra_remark) : composed;

    const updated = await pool.query(
      `UPDATE call_logs SET extra_remark = $1, remark = $2, edited_at = now()
        WHERE id = $3 RETURNING id, remark, extra_remark, edited_at`,
      [body.extra_remark || null, remark, id],
    );
    res.json({ call_log: updated.rows[0] });
  }),
);

export default router;
