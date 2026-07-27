function csvEscape(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  // A name/remark containing a comma or a quote previously broke the one
  // export that existed (AttendancePage) -- nothing quoted embedded commas.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Builds a CSV from already-loaded rows and triggers a browser download.
 * Client-side only -- exports what's currently on screen, not the full
 * result set behind server-side pagination (see PR notes for the larger,
 * deferred "export everything matching the filter" version). */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
): void {
  const csv = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
