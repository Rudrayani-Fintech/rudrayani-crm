import type { PoolClient } from "pg";
import { z } from "zod";
import { detectPaymentNormalization } from "./bucket-movement-service";
import { markOldestPendingPtpKept } from "./ptp-service";
import { nextReceiptNo } from "./receipt-service";

/**
 * Phase 6 (I2, §4.4): "money is recorded inside the interaction" -- a field
 * visit or call log can embed a payment instead of a separate POST
 * /payments round trip. Shared by call-logs.ts and field-visits.ts so both
 * go through the exact same receipt/exceeds-due-amount/bucket-movement/
 * PTP-kept logic the standalone payments.ts route already has -- a payment
 * recorded this way must show up identically in the ledger.
 *
 * Deliberately narrower than paymentBody in payments.ts: no close_customer,
 * no type override (always 'emi', the default) -- not part of §4.4's scope,
 * and closing a customer from inside a call/visit form is a bigger product
 * decision than this phase makes.
 */
export const embeddedPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  mode: z.string().trim().min(1).max(60).optional(),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
});
export type EmbeddedPayment = z.infer<typeof embeddedPaymentSchema>;

export async function recordEmbeddedPayment(
  client: PoolClient,
  params: {
    customerId: string;
    collectedByUserId: string;
    collectorBranchId: string | null;
    payment: EmbeddedPayment;
    clientKey: string | null;
    callLogId?: string | null;
    fieldVisitId?: string | null;
  },
): Promise<Record<string, unknown>> {
  // Same FOR UPDATE + paise-rounded comparison as payments.ts, so
  // exceeds_due_amount means the same thing regardless of which route
  // recorded the payment.
  const custRes = await client.query<{ due_amount: string | null }>(
    "SELECT due_amount FROM customers WHERE id = $1 FOR UPDATE",
    [params.customerId],
  );
  const dueAmount = custRes.rows[0]?.due_amount ?? null;
  const toPaise = (v: number | string): number => Math.round(Number(v) * 100);
  const exceedsDueAmount = dueAmount != null && toPaise(params.payment.amount) > toPaise(dueAmount);

  const receiptNo = await nextReceiptNo(client, params.collectorBranchId);

  const payRes = await client.query(
    `INSERT INTO payments
       (customer_id, collected_by_user_id, amount, mode, paid_at, client_key,
        exceeds_due_amount, receipt_no, call_log_id, field_visit_id)
     VALUES ($1, $2, $3, $4, COALESCE($5::date::timestamp AT TIME ZONE 'Asia/Kolkata', now()),
             $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      params.customerId,
      params.collectedByUserId,
      params.payment.amount,
      params.payment.mode ?? null,
      params.payment.paid_at ?? null,
      params.clientKey,
      exceedsDueAmount,
      receiptNo,
      params.callLogId ?? null,
      params.fieldVisitId ?? null,
    ],
  );

  await detectPaymentNormalization(client, params.customerId, payRes.rows[0].id);
  await markOldestPendingPtpKept(client, params.customerId, payRes.rows[0].id, params.payment.amount);
  return payRes.rows[0];
}
