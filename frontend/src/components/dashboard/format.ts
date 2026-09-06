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

export function pctText(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2).replace(/\.00$/, "")}%`;
}

// compactCount() and metricValue() went with the Management Dashboard's
// Amount/Count widget toggle (deleted in Phases 7/15); lakh() and pctText()
// are still used widely across the surviving pages and drawers.
