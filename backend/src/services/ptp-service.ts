import type { Pool, PoolClient } from "pg";
import { pool } from "../config/db";
import { istToday } from "../utils/ist";

/**
 * Called inside the payment-creation transaction (payments.ts). Marks the
 * customer's oldest still-pending PTP as kept -- the industry-standard
 * definition is "did the customer pay by the promised date", not "did they
 * pay the exact promised amount", so any payment against a customer with a
 * pending PTP counts. kept_amount records what was actually received (may
 * be less than the promised amount) and satisfied_by_payment_id links back
 * to the payment for drill-down. No-ops if the customer has no pending PTP.
 */
export async function markOldestPendingPtpKept(
  client: PoolClient,
  customerId: string,
  paymentId: string,
  paymentAmount: number,
): Promise<void> {
  await client.query(
    `UPDATE ptps
        SET status = 'kept', kept_amount = $3, satisfied_by_payment_id = $2
      WHERE id = (
        SELECT id FROM ptps
         WHERE customer_id = $1 AND status = 'pending'
         ORDER BY promised_date ASC
         LIMIT 1
         FOR UPDATE
      )`,
    [customerId, paymentId, paymentAmount],
  );
}

/**
 * Nightly job (scheduler.ts): any PTP whose promised date has passed and is
 * still 'pending' (no payment ever matched it via markOldestPendingPtpKept)
 * is broken. Without this, pending PTPs accumulate forever and
 * ptps_broken/ptp_conversion_pct never move. Also refreshes
 * next_action_date for every affected customer, since a PTP resolving here
 * may have been the earliest source for it.
 */
export async function markOverduePtpsBroken(): Promise<number> {
  const result = await pool.query(
    `WITH broken AS (
       UPDATE ptps SET status = 'broken'
        WHERE status = 'pending' AND promised_date < $1::date
        RETURNING customer_id
     )
     UPDATE customers c SET next_action_date = (
       SELECT MIN(d) FROM (
         SELECT promised_date AS d FROM ptps WHERE customer_id = c.id AND status = 'pending'
         UNION ALL
         SELECT (remind_at AT TIME ZONE 'Asia/Kolkata')::date AS d
           FROM reminders WHERE customer_id = c.id AND status = 'pending'
       ) sub
     )
     WHERE c.id IN (SELECT customer_id FROM broken)`,
    [istToday()],
  );
  return result.rowCount ?? 0;
}

/**
 * Recomputes a customer's next_action_date from scratch: the earliest of
 * their pending PTP promised_date and pending reminder remind_at date, or
 * NULL if neither exists. Call after creating, resolving, or cancelling a
 * PTP or reminder -- whichever one used to be the earliest source may no
 * longer be, and the customer may now have no pending follow-up at all.
 */
const DEFAULT_DAILY_ATTEMPT_CAP = 3;

/**
 * Phase 4 (§4.2): the day-plan engine. Extends the original two sources
 * (pending PTPs, pending reminders) with a third -- the latest call log's
 * disposition code, whose `followup_after_hours` says how long until this
 * customer should resurface on its own. Field visits don't yet carry a
 * disposition code at all (field_visits has no disposition_code_id column
 * -- no trail-code concept exists for them in the data model yet, a gap
 * bigger than this phase's file list covers), so only call_logs
 * contributes to this third source for now.
 *
 * `exits_agent_queue` on that same code means the customer leaves the
 * agent's queue entirely: unassigned from both the telecaller and field
 * agent, which is what actually removes them from GET /worklist (its
 * existing filter is `assigned_agent_id = me OR assigned_field_agent_id =
 * me`) without needing any change to that route. `routes_to` is stored as
 * data on the disposition code for admin/reporting visibility; where each
 * destination (field/manager/data_correction/closed) actually routes to
 * next is not built here -- an unassigned customer returns to the pool an
 * admin can reallocate from, same as any other unassignment today.
 */
export async function refreshNextActionDate(
  db: Pool | PoolClient,
  customerId: string,
): Promise<void> {
  const latest = await db.query<{
    exits_agent_queue: boolean;
    followup_after_hours: number | null;
  }>(
    `SELECT dc.exits_agent_queue, dc.followup_after_hours
       FROM call_logs cl
       JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
      WHERE cl.customer_id = $1
      ORDER BY cl.created_at DESC
      LIMIT 1`,
    [customerId],
  );
  const latestCode = latest.rows[0];

  if (latestCode?.exits_agent_queue) {
    await db.query(
      `UPDATE customers
          SET next_action_date = NULL, assigned_agent_id = NULL, assigned_field_agent_id = NULL
        WHERE id = $1`,
      [customerId],
    );
    return;
  }

  // Per-customer daily attempt cap (§4.2): once hit, the cadence source is
  // suppressed for the rest of the IST day regardless of what the code
  // says -- PTPs and reminders (explicit commitments, not auto-cycling)
  // still resurface normally. Configurable via agencies.settings, default 3.
  const attemptsToday = await db.query<{ count: number }>(
    `SELECT (
       (SELECT COUNT(*) FROM call_logs
          WHERE customer_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date)
       + (SELECT COUNT(*) FROM field_visits
          WHERE customer_id = $1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date)
     )::int AS count`,
    [customerId, istToday()],
  );
  const capResult = await db.query<{ cap: number }>(
    `SELECT COALESCE((a.settings->>'daily_attempt_cap')::int, $2) AS cap
       FROM customers c
       JOIN companies co ON co.id = c.company_id
       JOIN agencies a ON a.id = co.agency_id
      WHERE c.id = $1`,
    [customerId, DEFAULT_DAILY_ATTEMPT_CAP],
  );
  // "A fourth attempt... does not resurface them" -- the first 3 attempts
  // each still resurface normally, so this is a strict >, not >=.
  const capHit = attemptsToday.rows[0].count > (capResult.rows[0]?.cap ?? DEFAULT_DAILY_ATTEMPT_CAP);

  const cadenceDate =
    !capHit && latestCode?.followup_after_hours != null
      ? await db.query<{ d: string }>(
          `SELECT ((cl.created_at + ($2::int || ' hours')::interval) AT TIME ZONE 'Asia/Kolkata')::date AS d
             FROM call_logs cl
            WHERE cl.customer_id = $1
            ORDER BY cl.created_at DESC
            LIMIT 1`,
          [customerId, latestCode.followup_after_hours],
        )
      : null;

  await db.query(
    `UPDATE customers c
        SET next_action_date = (
          SELECT MIN(d) FROM (
            SELECT promised_date AS d FROM ptps WHERE customer_id = c.id AND status = 'pending'
            UNION ALL
            SELECT (remind_at AT TIME ZONE 'Asia/Kolkata')::date AS d
              FROM reminders WHERE customer_id = c.id AND status = 'pending'
            UNION ALL
            SELECT $2::date AS d WHERE $2::date IS NOT NULL
          ) sub
        )
      WHERE c.id = $1`,
    [customerId, cadenceDate?.rows[0]?.d ?? null],
  );
}
