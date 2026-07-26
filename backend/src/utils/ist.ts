/**
 * Single source of truth for "what day/month is it right now" in IST.
 *
 * Before this file existed, "today"/"this month" was computed three
 * different ways across the codebase: `new Date().toISOString().slice(0,10)`
 * (UTC — wrong for the first 5.5 hours of every IST day), bare SQL
 * `date_trunc('month', now())` (also UTC, since the DB session clock is
 * UTC), and a `toLocaleString(...).timeZone` round-trip in report-service.ts
 * (works, but is a fragile, ICU-build-dependent pattern not worth repeating
 * by hand at every call site). Use these helpers instead of reimplementing
 * any of the three.
 */

export const IST_TZ = "Asia/Kolkata";

/** SQL fragment to convert a `timestamptz` column to IST wall-clock time. */
export const IST_AT_TIME_ZONE = "AT TIME ZONE 'Asia/Kolkata'";

/** Today's date in IST, as 'YYYY-MM-DD'. */
export function istToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: IST_TZ });
}

/** First day of the current IST month, as 'YYYY-MM-01'. */
export function istMonthStart(now: Date = new Date()): string {
  return `${istToday(now).slice(0, 7)}-01`;
}

/** Current IST month as 'YYYY-MM'. */
export function istMonth(now: Date = new Date()): string {
  return istToday(now).slice(0, 7);
}
