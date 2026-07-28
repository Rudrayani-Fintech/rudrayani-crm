import cron from "node-cron";
import { pool } from "../config/db";
import { logger } from "../config/logger";
import { purgeOldLocationPings, PING_RETENTION_DAYS } from "./purge-pings";
import { markOverduePtpsBroken } from "../services/ptp-service";
import { refreshAllDpd } from "./refresh-dpd";

// Arbitrary, distinct 32-bit keys -- pg_try_advisory_lock's keyspace is
// shared across the whole database, so these just need to not collide with
// each other or with any other advisory lock this app might take elsewhere
// (none currently exist).
const JOB_LOCK_KEYS = {
  purgePings: 187_001,
  ptpSweep: 187_002,
  dpdRefresh: 187_003,
} as const;

/**
 * node-cron runs in-process with no coordination between instances -- on
 * more than one server replica, every one of them fires its own copy of
 * every job at the same scheduled time. Each job here happens to be
 * idempotent on its own (purge/sweep/refresh all just find nothing left to
 * do on a second run), so this was never a correctness bug, only wasted
 * duplicate work -- but "happens to be idempotent today" isn't something to
 * keep relying on as more jobs get added. A Postgres advisory lock (already
 * have the pool, no new infrastructure) makes only one instance actually
 * run the job body; every other instance's attempt no-ops immediately.
 */
async function runWithLock(lockKey: number, jobName: string, fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [
      lockKey,
    ]);
    if (!rows[0]?.acquired) {
      logger.info(`${jobName}: another instance already holds the job lock, skipping`);
      return;
    }
    try {
      await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    }
  } finally {
    client.release();
  }
}

/**
 * In-process scheduled jobs, started from server.ts only (never in tests).
 * Task 4.1: daily location-ping purge at 03:00 (60-day retention, brief §9).
 * Phase 2.1: daily overdue-PTP sweep -- a PTP that was never matched by a
 * payment (see markOldestPendingPtpKept in ptp-service.ts) needs something
 * to eventually flip it to 'broken', or it sits at 'pending' forever.
 * Phase 2.4: daily DPD refresh -- unlike the other jobs, this doesn't fix a
 * one-off write gap, it keeps a value fresh that changes every day purely
 * from time passing, for every active customer with a due_date.
 */
export function startScheduledJobs(): void {
  cron.schedule("0 3 * * *", () =>
    runWithLock(JOB_LOCK_KEYS.purgePings, "Purge job", async () => {
      try {
        const purged = await purgeOldLocationPings();
        logger.info(`Purge job: removed ${purged} location pings older than ${PING_RETENTION_DAYS} days`);
      } catch (err) {
        logger.error({ err }, "Purge job failed");
      }
    }),
  );
  cron.schedule("10 3 * * *", () =>
    runWithLock(JOB_LOCK_KEYS.ptpSweep, "PTP sweep job", async () => {
      try {
        const broken = await markOverduePtpsBroken();
        logger.info(`PTP sweep: marked ${broken} overdue PTPs as broken`);
      } catch (err) {
        logger.error({ err }, "PTP sweep job failed");
      }
    }),
  );
  cron.schedule("20 3 * * *", () =>
    runWithLock(JOB_LOCK_KEYS.dpdRefresh, "DPD refresh job", async () => {
      try {
        const updated = await refreshAllDpd();
        logger.info(`DPD refresh: updated ${updated} customers`);
      } catch (err) {
        logger.error({ err }, "DPD refresh job failed");
      }
    }),
  );
  logger.info("Scheduled jobs started (ping purge, PTP sweep, DPD refresh daily from 03:00)");
}
