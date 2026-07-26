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
export async function refreshNextActionDate(
  db: Pool | PoolClient,
  customerId: string,
): Promise<void> {
  await db.query(
    `UPDATE customers c
        SET next_action_date = (
          SELECT MIN(d) FROM (
            SELECT promised_date AS d FROM ptps WHERE customer_id = c.id AND status = 'pending'
            UNION ALL
            SELECT (remind_at AT TIME ZONE 'Asia/Kolkata')::date AS d
              FROM reminders WHERE customer_id = c.id AND status = 'pending'
          ) sub
        )
      WHERE c.id = $1`,
    [customerId],
  );
}
