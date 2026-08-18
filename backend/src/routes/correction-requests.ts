import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { capabilitiesHavePermission } from "../services/permission-service";
import { type BranchClamp, resolveBranchClamp } from "../services/scope";
import { capabilitiesOf } from "../types/user";

/**
 * Agent-initiated correction requests for a payment/call-log/PTP they
 * created — MVP hardening: previously there was no way to fix a mistaken
 * amount or a garbled remark after saving, anywhere in the app. Mirrors
 * reallocation-requests.ts's request/approve pattern almost exactly.
 *
 * Only a narrow, server-side allow-list of fields is ever correctable per
 * record_type — never customer_id, the owning agent/collector, or any
 * timestamp. This list is intentionally conservative: e.g. a call log's
 * disposition_code_id is NOT correctable here, because retroactively
 * changing it could invalidate an already-created PTP or change which
 * fields should have been required — that needs a different workflow, not
 * a field-level patch.
 */
const router = Router();
router.use(authenticate);

const RECORD_TYPES = ["payment", "call_log", "ptp", "field_visit"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

const ALLOWED_FIELDS: Record<RecordType, readonly string[]> = {
  payment: ["amount", "mode", "paid_at"],
  call_log: ["remark"],
  ptp: ["amount", "promised_date"],
  field_visit: ["remark"],
};

const proposedChangesSchema = z.record(z.string(), z.union([z.string(), z.number()]));

function assertAllowedFields(recordType: RecordType, changes: Record<string, unknown>): void {
  const allowed = ALLOWED_FIELDS[recordType];
  const keys = Object.keys(changes);
  if (keys.length === 0) throw new HttpError(400, "proposed_changes must include at least one field");
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length > 0) {
    throw new HttpError(400, `These fields are not correctable for ${recordType}: ${bad.join(", ")}`);
  }
}

/**
 * Same branch clamp as scope.ts's customerBranchClamp(), but correction_requests
 * has no customer_id of its own -- the customer only exists behind whichever
 * of the three COALESCE'd source-table joins actually matches record_type.
 * Doesn't fit the single-alias helper, so this is its own small variant.
 */
function coalescedCustomerBranchClamp(clamp: BranchClamp, params: unknown[]): string {
  if (!clamp) return "";
  params.push(clamp.branchId, clamp.branchName);
  const idN = params.length - 1;
  const nameN = params.length;
  const branchIdExpr = "COALESCE(cust_p.branch_id, cust_c.branch_id, cust_t.branch_id, cust_f.branch_id)";
  const customFieldsExpr =
    "COALESCE(cust_p.custom_fields, cust_c.custom_fields, cust_t.custom_fields, cust_f.custom_fields)";
  return ` AND (${branchIdExpr}::text = $${idN} OR (${branchIdExpr} IS NULL AND (${customFieldsExpr}->>'branch' ILIKE $${nameN} OR ${customFieldsExpr}->>'Branch' ILIKE $${nameN})))`;
}

/** Ownership + agency-scope check for the record being flagged. Returns the row, or throws 404. */
async function loadOwnedRecord(
  recordType: RecordType,
  recordId: string,
  userId: string,
  agencyId: string,
): Promise<Record<string, unknown>> {
  const queries: Record<RecordType, string> = {
    payment: `SELECT p.* FROM payments p
                JOIN customers c ON c.id = p.customer_id
                JOIN companies co ON co.id = c.company_id
               WHERE p.id = $1 AND co.agency_id = $2 AND p.collected_by_user_id = $3`,
    call_log: `SELECT cl.* FROM call_logs cl
                 JOIN customers c ON c.id = cl.customer_id
                 JOIN companies co ON co.id = c.company_id
                WHERE cl.id = $1 AND co.agency_id = $2 AND cl.agent_id = $3`,
    ptp: `SELECT p.* FROM ptps p
            JOIN customers c ON c.id = p.customer_id
            JOIN companies co ON co.id = c.company_id
           WHERE p.id = $1 AND co.agency_id = $2 AND p.agent_id = $3`,
    field_visit: `SELECT fv.* FROM field_visits fv
                    JOIN customers c ON c.id = fv.customer_id
                    JOIN companies co ON co.id = c.company_id
                   WHERE fv.id = $1 AND co.agency_id = $2 AND fv.agent_id = $3`,
  };
  const { rows } = await pool.query(queries[recordType], [recordId, agencyId, userId]);
  if (!rows[0]) throw new HttpError(404, "Record not found, or it isn't yours");
  return rows[0];
}

/** Agent flags one of their own payments/call-logs/PTPs as needing a correction. */
router.post(
  "/",
  requirePermission("calls.log"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        record_type: z.enum(RECORD_TYPES),
        record_id: z.string().uuid(),
        proposed_changes: proposedChangesSchema,
        reason: z.string().trim().min(3).max(500),
      })
      .parse(req.body);

    assertAllowedFields(body.record_type, body.proposed_changes);
    await loadOwnedRecord(body.record_type, body.record_id, req.user!.id, req.user!.agency_id);

    const { rows } = await pool.query(
      `INSERT INTO correction_requests (record_type, record_id, requested_by, reason, proposed_changes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [body.record_type, body.record_id, req.user!.id, body.reason, JSON.stringify(body.proposed_changes)],
    );
    res.status(201).json({ request: rows[0] });
  }),
);

/**
 * List requests. TL/ops (customers.allocate) see the whole agency's queue;
 * a plain agent sees only requests they submitted — same self-clamp
 * convention already used in reminders.ts/ptps.ts.
 */
router.get(
  "/",
  requirePermission("calls.log"),
  asyncHandler(async (req, res) => {
    const status = z
      .enum(["pending", "approved", "rejected", "all"])
      .default("pending")
      .parse(req.query.status ?? "pending");
    const seesAll = await capabilitiesHavePermission(capabilitiesOf(req.user!), "customers.allocate");

    const params: unknown[] = [];
    const filters: string[] = [];
    if (status !== "all") {
      params.push(status);
      filters.push(`cr.status = $${params.length}`);
    }
    if (!seesAll) {
      params.push(req.user!.id);
      filters.push(`cr.requested_by = $${params.length}`);
    } else {
      // Between "own requests only" and "whole agency" -- a branch_manager
      // only ever sees their own branch's approval queue.
      const clamp = await resolveBranchClamp(req.user!);
      const clampSql = coalescedCustomerBranchClamp(clamp, params);
      if (clampSql) filters.push(clampSql.replace(/^ AND /, ""));
    }
    params.push(req.user!.agency_id);
    const agencyParamIndex = params.length;

    // Agency scope is enforced by joining out to whichever table the
    // record lives in, since correction_requests itself has no agency_id.
    // record_type picks which of the three source tables actually owns the
    // row, so each LEFT JOIN only ever matches one of them per request.
    const { rows } = await pool.query(
      `SELECT cr.id, cr.record_type, cr.record_id, cr.reason, cr.proposed_changes,
              cr.status, cr.decided_at, cr.decision_note, cr.created_at,
              u.id AS requested_by_id, u.full_name AS requested_by_name,
              d.full_name AS decided_by_name,
              COALESCE(cust_p.id, cust_c.id, cust_t.id, cust_f.id) AS customer_id,
              COALESCE(cust_p.loan_number, cust_c.loan_number, cust_t.loan_number, cust_f.loan_number) AS loan_number,
              COALESCE(cust_p.customer_name, cust_c.customer_name, cust_t.customer_name, cust_f.customer_name) AS customer_name
         FROM correction_requests cr
         JOIN users u ON u.id = cr.requested_by
         LEFT JOIN users d ON d.id = cr.decided_by
         LEFT JOIN payments py ON cr.record_type = 'payment' AND py.id = cr.record_id
         LEFT JOIN customers cust_p ON cust_p.id = py.customer_id
         LEFT JOIN call_logs cl ON cr.record_type = 'call_log' AND cl.id = cr.record_id
         LEFT JOIN customers cust_c ON cust_c.id = cl.customer_id
         LEFT JOIN ptps pt ON cr.record_type = 'ptp' AND pt.id = cr.record_id
         LEFT JOIN customers cust_t ON cust_t.id = pt.customer_id
         LEFT JOIN field_visits fv ON cr.record_type = 'field_visit' AND fv.id = cr.record_id
         LEFT JOIN customers cust_f ON cust_f.id = fv.customer_id
        WHERE u.agency_id = $${agencyParamIndex}
          ${filters.map((f) => `AND ${f}`).join(" ")}
        ORDER BY cr.created_at DESC`,
      params,
    );
    res.json({ requests: rows, total: rows.length });
  }),
);

/**
 * Approve (applies the allow-listed changes transactionally) or reject one
 * request. Shared by the single-request route below and the bulk route.
 */
async function decideOne(
  agencyId: string,
  userId: string,
  clamp: BranchClamp,
  id: string,
  approve: boolean,
  note: string | undefined,
) {
  // A branch_manager can only decide requests whose underlying customer
  // is in their own branch -- same three-way COALESCE join as GET / above,
  // since correction_requests doesn't carry a customer_id of its own.
  const reqParams: unknown[] = [id, agencyId];
  const reqClampSql = coalescedCustomerBranchClamp(clamp, reqParams);
  const reqRes = await pool.query(
    `SELECT cr.* FROM correction_requests cr
       JOIN users u ON u.id = cr.requested_by
       LEFT JOIN payments py ON cr.record_type = 'payment' AND py.id = cr.record_id
       LEFT JOIN customers cust_p ON cust_p.id = py.customer_id
       LEFT JOIN call_logs cl ON cr.record_type = 'call_log' AND cl.id = cr.record_id
       LEFT JOIN customers cust_c ON cust_c.id = cl.customer_id
       LEFT JOIN ptps pt ON cr.record_type = 'ptp' AND pt.id = cr.record_id
       LEFT JOIN customers cust_t ON cust_t.id = pt.customer_id
       LEFT JOIN field_visits fv ON cr.record_type = 'field_visit' AND fv.id = cr.record_id
       LEFT JOIN customers cust_f ON cust_f.id = fv.customer_id
      WHERE cr.id = $1 AND u.agency_id = $2${reqClampSql}`,
    reqParams,
  );
  const request = reqRes.rows[0];
  if (!request) throw new HttpError(404, "Request not found");
  if (request.status !== "pending") throw new HttpError(409, "Request already decided");

  const recordType = request.record_type as RecordType;
  const proposedChanges = request.proposed_changes as Record<string, unknown>;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (approve) {
      assertAllowedFields(recordType, proposedChanges);
      const table = { payment: "payments", call_log: "call_logs", ptp: "ptps", field_visit: "field_visits" }[recordType];
      const setClauses: string[] = [];
      const values: unknown[] = [];
      for (const [field, value] of Object.entries(proposedChanges)) {
        values.push(value);
        setClauses.push(`${field} = $${values.length}`);
      }
      values.push(request.record_id);
      await client.query(
        `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = $${values.length}`,
        values,
      );
    }

    const updated = await client.query(
      `UPDATE correction_requests
          SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE id = $1 RETURNING *`,
      [id, approve ? "approved" : "rejected", userId, note ?? null],
    );

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

router.post(
  "/:id/decide",
  requirePermission("customers.allocate"),
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        approve: z.boolean(),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const clamp = await resolveBranchClamp(req.user!);
    const request = await decideOne(req.user!.agency_id, req.user!.id, clamp, id, body.approve, body.note);
    res.json({ request });
  }),
);

/**
 * Bulk approve/reject -- mirrors import-reviews.ts's bulk-decision: each id
 * is decided independently (its own transaction), so one already-decided
 * request in the batch doesn't roll back everyone else's.
 */
router.post(
  "/bulk-decide",
  requirePermission("customers.allocate"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(200),
        approve: z.boolean(),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);

    const clamp = await resolveBranchClamp(req.user!);
    const applied: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of body.ids) {
      try {
        await decideOne(req.user!.agency_id, req.user!.id, clamp, id, body.approve, body.note);
        applied.push(id);
      } catch (err) {
        skipped.push({ id, reason: err instanceof HttpError ? err.message : "Unexpected error" });
      }
    }
    res.json({ applied, skipped });
  }),
);

export default router;
