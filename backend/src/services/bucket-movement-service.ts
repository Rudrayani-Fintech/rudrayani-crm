import type { PoolClient } from "pg";
import { istMonthStart } from "../utils/ist";

/**
 * Bucket movement events (Phase 7): the lender's file stays the authoritative
 * bucket on `customers` -- these are an informational, in-house signal that
 * either (a) a payment shows a customer likely cleared their arrears before
 * the lender's next file confirms it, or (b) an allocation import itself
 * confirms a bucket drop between two consecutive month snapshots. Neither
 * path ever writes to `customers.bucket`.
 */

interface BucketMeta {
  label: string;
  canonical_bucket: number | null;
  sort_order: number;
  is_current: boolean;
}

/**
 * Called inside the payment-creation transaction. Detects "this customer's
 * payments this month cover their arrears for their current bucket" using
 * canonical_bucket * emi (N EMIs overdue) as the threshold, falling back to
 * due_amount when emi is missing. Silently no-ops when the bucket isn't
 * canonically mapped yet, is already the "current" bucket (canonical 0), or
 * both emi and due_amount are missing (undetectable) -- these are documented
 * limitations, not errors. The partial unique index on
 * (customer_id, month) WHERE trigger='payment' makes this idempotent: a
 * second qualifying payment in the same month never creates a duplicate.
 */
export async function detectPaymentNormalization(
  client: PoolClient,
  customerId: string,
  paymentId: string,
): Promise<void> {
  const custRes = await client.query(
    `SELECT bucket, company_id, emi, due_amount FROM customers WHERE id = $1`,
    [customerId],
  );
  const cust = custRes.rows[0];
  if (!cust || !cust.bucket) return;

  const bucketRes = await client.query<BucketMeta>(
    `SELECT label, canonical_bucket, sort_order, is_current
       FROM buckets WHERE company_id = $1 AND label = $2`,
    [cust.company_id, cust.bucket],
  );
  const bucketRow = bucketRes.rows[0];
  if (!bucketRow || bucketRow.canonical_bucket === null || bucketRow.canonical_bucket === 0) return;

  const emi = cust.emi !== null ? Number(cust.emi) : null;
  const dueAmount = cust.due_amount !== null ? Number(cust.due_amount) : null;
  let threshold: number;
  if (emi !== null && emi > 0) {
    threshold = bucketRow.canonical_bucket * emi; // N EMIs overdue
  } else if (dueAmount !== null && dueAmount > 0) {
    threshold = dueAmount;
  } else {
    return; // both missing -- undetectable, not an error
  }

  // Bare `date_trunc('month', now())` resolves in the DB session's timezone
  // (UTC), so a payment in the first ~5.5h of an IST day was compared
  // against the wrong month boundary. Compute the IST month start in JS and
  // bind it, matching the `$N::date::timestamp AT TIME ZONE` idiom used for
  // report queries elsewhere.
  const monthStart = istMonthStart();

  const paidRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments
      WHERE customer_id = $1 AND paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    [customerId, monthStart],
  );
  if (Number(paidRes.rows[0].total) < threshold) return;

  const currentBucketRes = await client.query(
    `SELECT label FROM buckets WHERE company_id = $1 AND is_current = true LIMIT 1`,
    [cust.company_id],
  );
  const currentBucketLabel = (currentBucketRes.rows[0]?.label as string | undefined) ?? null;

  await client.query(
    `INSERT INTO bucket_movements
       (customer_id, company_id, from_bucket, to_bucket, from_canonical, to_canonical,
        trigger, month, payment_id)
     VALUES ($1, $2, $3, $4, $5, 0, 'payment', $6::date, $7)
     ON CONFLICT (customer_id, month) WHERE trigger = 'payment' DO NOTHING`,
    [customerId, cust.company_id, cust.bucket, currentBucketLabel, bucketRow.canonical_bucket, monthStart, paymentId],
  );
}

/**
 * Called from the allocation import commit path, once per updated customer,
 * after its `customers.bucket` has been written for this run. Compares the
 * customer's most recent PRIOR month's snapshot bucket to the new bucket
 * (ranked by canonical_bucket where mapped, falling back to sort_order) and
 * records a confirmation event if it dropped or landed on the "current"
 * bucket. No-ops when there's no prior month to compare against, the bucket
 * label is unchanged, or either label isn't in the buckets master.
 */
export async function detectAllocationConfirmation(
  client: PoolClient,
  customerId: string,
  companyId: string,
  allocationMonth: string,
  importRunId: string,
): Promise<void> {
  const prevRes = await client.query(
    `SELECT bucket FROM customer_month_snapshots
      WHERE customer_id = $1 AND month < $2 AND bucket IS NOT NULL
      ORDER BY month DESC LIMIT 1`,
    [customerId, allocationMonth],
  );
  const prevBucket = prevRes.rows[0]?.bucket as string | undefined;
  if (!prevBucket) return;

  const newRes = await client.query(`SELECT bucket FROM customers WHERE id = $1`, [customerId]);
  const newBucket = newRes.rows[0]?.bucket as string | null;
  if (!newBucket || newBucket === prevBucket) return;

  const bucketsRes = await client.query<BucketMeta>(
    `SELECT label, canonical_bucket, sort_order, is_current
       FROM buckets WHERE company_id = $1 AND label = ANY($2)`,
    [companyId, [prevBucket, newBucket]],
  );
  const byLabel = new Map(bucketsRes.rows.map((r) => [r.label, r]));
  const prevMeta = byLabel.get(prevBucket);
  const newMeta = byLabel.get(newBucket);
  if (!prevMeta || !newMeta) return;

  const prevRank = prevMeta.canonical_bucket ?? prevMeta.sort_order;
  const newRank = newMeta.canonical_bucket ?? newMeta.sort_order;
  if (!(newRank < prevRank || newMeta.is_current)) return;

  await client.query(
    `INSERT INTO bucket_movements
       (customer_id, company_id, from_bucket, to_bucket, from_canonical, to_canonical,
        trigger, month, import_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'allocation', $7, $8)`,
    [
      customerId,
      companyId,
      prevBucket,
      newBucket,
      prevMeta.canonical_bucket,
      newMeta.canonical_bucket,
      allocationMonth,
      importRunId,
    ],
  );
}
