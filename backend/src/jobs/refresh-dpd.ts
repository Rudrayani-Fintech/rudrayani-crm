import { pool } from "../config/db";

/**
 * customers.dpd (days past due) is a stored proxy for what report-service.ts
 * used to compute ad hoc on every request (CURRENT_DATE - due_date) so it
 * can be filtered/sorted/indexed. Unlike a value that only changes on a
 * write event, DPD advances every single day purely from the passage of
 * time -- a customer nobody has touched since import still needs their DPD
 * to climb daily, so this has to run on a schedule rather than only from
 * import/payment handlers.
 */
export async function refreshAllDpd(): Promise<number> {
  const result = await pool.query(
    `UPDATE customers
        SET dpd = GREATEST((now() AT TIME ZONE 'Asia/Kolkata')::date - due_date, 0)
      WHERE due_date IS NOT NULL AND status = 'active'`,
  );
  return result.rowCount ?? 0;
}
