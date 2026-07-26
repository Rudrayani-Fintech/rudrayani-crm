/**
 * Standalone runner for the overdue-PTP-to-broken job.
 * The API server also runs this daily in-process via node-cron (see
 * scheduler.ts); keep this script for manual runs / external cron:
 *   npm run mark:broken-ptps
 */
import { pool } from "../config/db";
import { markOverduePtpsBroken } from "../services/ptp-service";

markOverduePtpsBroken()
  .then(async (count) => {
    console.log(`Marked ${count} overdue PTPs as broken`);
    await pool.end();
  })
  .catch((err) => {
    console.error("Mark-broken-PTPs job failed:", err);
    process.exit(1);
  });
