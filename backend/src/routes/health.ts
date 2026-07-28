import fs from "fs";
import path from "path";
import { Router } from "express";
import { pool } from "../config/db";
import { logger } from "../config/logger";

// A runtime file read, not a TS module import -- package.json lives outside
// tsconfig.build.json's rootDir ("src"), so `import ... from "../../package.json"`
// would fail the build with "File is not under 'rootDir'".
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8")) as {
  version: string;
};

const router = Router();

// GET /api/health -> confirms the API is up and can reach Postgres.
// Render's own health check just hits this one URL (no separate liveness/
// readiness probes to serve), so kept as one endpoint -- but previously
// carried no version/build identifier at all, making "did the last deploy
// actually roll out" a question only answerable by checking Render's own
// dashboard instead of the API itself.
router.get("/health", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as server_time");
    res.json({
      status: "ok",
      db_connected: true,
      server_time: result.rows[0].server_time,
      version,
    });
  } catch (err) {
    logger.error({ err }, "Health check DB error");
    res.status(500).json({ status: "error", db_connected: false, version });
  }
});

export default router;
