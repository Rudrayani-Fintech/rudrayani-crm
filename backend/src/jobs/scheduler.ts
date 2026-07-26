import cron from "node-cron";
import { logger } from "../config/logger";
import { purgeOldLocationPings, PING_RETENTION_DAYS } from "./purge-pings";
import { markOverduePtpsBroken } from "../services/ptp-service";
import { refreshAllDpd } from "./refresh-dpd";

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
  cron.schedule("0 3 * * *", async () => {
    try {
      const purged = await purgeOldLocationPings();
      logger.info(`Purge job: removed ${purged} location pings older than ${PING_RETENTION_DAYS} days`);
    } catch (err) {
      logger.error({ err }, "Purge job failed");
    }
  });
  cron.schedule("10 3 * * *", async () => {
    try {
      const broken = await markOverduePtpsBroken();
      logger.info(`PTP sweep: marked ${broken} overdue PTPs as broken`);
    } catch (err) {
      logger.error({ err }, "PTP sweep job failed");
    }
  });
  cron.schedule("20 3 * * *", async () => {
    try {
      const updated = await refreshAllDpd();
      logger.info(`DPD refresh: updated ${updated} customers`);
    } catch (err) {
      logger.error({ err }, "DPD refresh job failed");
    }
  });
  logger.info("Scheduled jobs started (ping purge, PTP sweep, DPD refresh daily from 03:00)");
}
