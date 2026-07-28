import { createApp } from "./app";
import { pool } from "./config/db";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { startScheduledJobs } from "./jobs/scheduler";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Rudrayani CRM backend running on http://localhost:${env.PORT}`);
});

startScheduledJobs();

// Without this, a Render deploy/restart's SIGTERM killed the process
// immediately -- Node's default action for SIGTERM is to terminate right
// away, cutting off whatever requests were in flight and however many DB
// connections the pool was mid-query on. This stops accepting new
// connections, lets in-flight requests finish, then closes the pool before
// exiting -- the standard graceful-shutdown sequence.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down gracefully");
  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, "Error closing Postgres pool during shutdown");
    }
    process.exit(0);
  });
  // Render's own kill timeout is longer than this, but don't hang forever
  // if a stuck connection never lets server.close()'s callback fire.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
