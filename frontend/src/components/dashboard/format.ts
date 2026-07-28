/** Lakh/crore-notation money + count formatting per the dashboard blueprint ("1.04Cr", "1K"). */

export function lakh(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  // A 10+ crore portfolio previously had no rollover past lakh and rendered
  // as e.g. "1039.39L" -- a number an Indian collections owner reads as
  // simply wrong, not just unfamiliar notation.
  const cr = value / 1_00_00_000;
  if (Math.abs(cr) >= 1) return `${cr.toFixed(2)}Cr`;
  const l = value / 100000;
  if (Math.abs(l) >= 0.01) return `${l.toFixed(2)}L`;
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
}

export function compactCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  return String(value);
}

export function pctText(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2).replace(/\.00$/, "")}%`;
}

/** Amount/Count toggle picks which field of a metric block a card shows. */
export function metricValue(
  amountMode: boolean,
  amount: number | null | undefined,
  count: number | null | undefined,
): string {
  return amountMode ? lakh(amount) : compactCount(count);
}
