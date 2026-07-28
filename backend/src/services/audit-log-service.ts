import type { PoolClient } from "pg";
import { pool } from "../config/db";
import { logger } from "../config/logger";

/**
 * Records a sensitive account/money action for later review. Called from
 * inside an existing transaction where one is already open (so the audit
 * row commits or rolls back atomically with the action it describes);
 * otherwise called against the bare pool. A logging failure must never mask
 * or block the action it's describing, so errors are caught and logged, not
 * rethrown.
 */
export async function recordAuditLog(
  client: PoolClient | typeof pool,
  entry: {
    agencyId: string;
    actorId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_logs (agency_id, actor_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.agencyId,
        entry.actorId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.details ? JSON.stringify(entry.details) : null,
      ],
    );
  } catch (err) {
    logger.error({ err, entry }, "Failed to write audit log entry");
  }
}
