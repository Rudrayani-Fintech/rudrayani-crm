import { Pool, types } from "pg";
import { env } from "./env";
import { logger } from "./logger";

// node-postgres's default DATE (oid 1082) parser builds a JS Date at LOCAL
// midnight for the given y-m-d. Serializing that Date (res.json(), Array,
// JSON.stringify -- anything that calls .toISOString()) converts to UTC,
// which silently rolls the date back a day in any timezone ahead of UTC
// (IST included) -- e.g. a due_date of 2026-07-08 comes back as
// "2026-07-07T18:30:00.000Z" and API consumers read it as the 7th. DATE
// columns here are pure calendar dates (due_date, allocation_month, month,
// promised_date) with no time-of-day meaning, so keep them as the raw
// 'YYYY-MM-DD' string Postgres sends instead of ever constructing a Date.
types.setTypeParser(1082, (value) => value);

// Single shared connection pool for the app. Previously had none of these
// set -- an unbounded pool size meant nothing stopped one runaway request
// path (e.g. the per-row import loop) from opening far more connections
// than Postgres or Render's plan actually allows; no connectionTimeoutMillis
// meant a request could hang indefinitely waiting for a client instead of
// failing fast; no statement_timeout meant one pathological query could
// hold a connection (and a row lock) forever.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
});

pool.on("error", (err) => {
  // Previously process.exit(1) here -- an idle client erroring (a dropped
  // connection, a transient network blip) is not the same as the whole
  // application being broken, but killing the process took down every
  // in-flight request on every OTHER connection along with it. node-postgres
  // already removes the errored client from the pool on its own; logging
  // and continuing lets the pool open a fresh connection for the next query
  // instead of the entire server going down for a recoverable hiccup.
  logger.error({ err }, "Unexpected error on idle Postgres client");
});
