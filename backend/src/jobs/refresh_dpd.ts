/**
 * Standalone runner for the DPD refresh job.
 * The API server also runs this daily in-process via node-cron (see
 * scheduler.ts); keep this script for manual runs / external cron:
 *   npm run refresh:dpd
 */
import { pool } from "../config/db";
import { refreshAllDpd } from "./refresh-dpd";

refreshAllDpd()
  .then(async (count) => {
    console.log(`Refreshed DPD for ${count} customers`);
    await pool.end();
  })
  .catch((err) => {
    console.error("DPD refresh job failed:", err);
    process.exit(1);
  });
