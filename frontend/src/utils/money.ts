const rupeeFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/**
 * Plain rupee display for an individual figure -- a due amount, a single
 * payment, an EMI. Always carries the ₹ symbol and en-IN comma grouping.
 * Previously this exact shape (bare `Number(v).toLocaleString("en-IN")`,
 * no currency symbol) was copy-pasted as a local `fmtAmount` in eight
 * different files, so a due amount rendered as a bare number indistinguishable
 * from a count.
 *
 * For portfolio/aggregate totals where lakh/crore notation reads better
 * (a dashboard total, a branch rollup), use `lakh()` from
 * `components/dashboard/format.ts` instead -- this function intentionally
 * never switches to L/Cr notation, since an individual customer's ₹18,000
 * due amount read as "0.18L" is worse, not better.
 */
export function rupees(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return rupeeFormatter.format(n);
}
