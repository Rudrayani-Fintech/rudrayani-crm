import type { PoolClient } from "pg";
import { istToday } from "../utils/ist";

/** Indian financial year (Apr 1 - Mar 31) as "25-26" for a date in FY2025-26. */
function financialYearCode(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`;
}

/** Short, receipt-safe code derived from a branch name -- there is no
 * dedicated branch code column, so this strips to alphanumerics and takes
 * the first 4 characters. Falls back to "GEN" for a payment with no
 * resolvable branch (e.g. an agency_admin recording directly, or a
 * telecaller with no scalar branch_id). */
function branchCode(branchName: string | null): string {
  if (!branchName) return "GEN";
  const alnum = branchName.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return alnum.slice(0, 4) || "GEN";
}

/**
 * Generates the next receipt number for a payment, atomically, inside the
 * caller's transaction. Format: RD/<BRANCH>/<FY>/<seq>, e.g.
 * "RD/SANG/25-26/00042". The counter is scoped per branch+financial-year
 * (receipt_sequences), not global, matching how a paper receipt book is
 * normally organized per branch per year.
 */
export async function nextReceiptNo(client: PoolClient, collectorBranchId: string | null): Promise<string> {
  let branchName: string | null = null;
  if (collectorBranchId) {
    const { rows } = await client.query("SELECT name FROM branches WHERE id = $1", [collectorBranchId]);
    branchName = (rows[0]?.name as string | undefined) ?? null;
  }
  const scopeKey = `RD/${branchCode(branchName)}/${financialYearCode(istToday())}`;

  const { rows } = await client.query<{ next_seq: number }>(
    `INSERT INTO receipt_sequences (scope_key, next_seq) VALUES ($1, 1)
       ON CONFLICT (scope_key) DO UPDATE SET next_seq = receipt_sequences.next_seq + 1
     RETURNING next_seq`,
    [scopeKey],
  );
  const seq = rows[0].next_seq;
  return `${scopeKey}/${String(seq).padStart(5, "0")}`;
}
