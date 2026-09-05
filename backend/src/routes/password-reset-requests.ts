import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { recordAuditLog } from "../services/audit-log-service";
import { agentBranchClamp, resolveBranchClamp } from "../services/scope";

/**
 * Phase 2 (A4, S1-S3): the admin-facing side of the mobile-forgot-password
 * flow -- POST /auth/password-reset-request (unauthenticated, see auth.ts)
 * creates the row; this queue is where an admin/branch manager sees and
 * resolves it. The actual reset stays POST /employees/:id/reset-password
 * (Phase 1) -- resolving here only marks the request handled, it doesn't
 * itself change any password.
 */
const router = Router();
router.use(authenticate);

router.get(
  "/",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const status = z
      .enum(["pending", "resolved", "rejected", "all"])
      .default("pending")
      .parse(req.query.status ?? "pending");

    const clamp = await resolveBranchClamp(req.user!);
    const params: unknown[] = [req.user!.agency_id];
    const filters: string[] = ["u.agency_id = $1"];
    if (status !== "all") {
      params.push(status);
      filters.push(`prr.status = $${params.length}`);
    }
    const clampSql = agentBranchClamp(clamp, params, "u");
    if (clampSql) filters.push(clampSql.replace(/^ AND /, ""));

    const { rows } = await pool.query(
      `SELECT prr.id, prr.message, prr.status, prr.created_at, prr.resolved_at,
              u.id AS user_id, u.full_name, u.phone,
              r.full_name AS resolved_by_name
         FROM password_reset_requests prr
         JOIN users u ON u.id = prr.user_id
         LEFT JOIN users r ON r.id = prr.resolved_by
        WHERE ${filters.join(" AND ")}
        ORDER BY prr.created_at DESC`,
      params,
    );
    res.json({ password_reset_requests: rows });
  }),
);

router.post(
  "/:id/resolve",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const clamp = await resolveBranchClamp(req.user!);
    const params: unknown[] = [id, req.user!.agency_id];
    const filters = ["prr.id = $1", "u.agency_id = $2", "prr.status = 'pending'"];
    const clampSql = agentBranchClamp(clamp, params, "u");
    if (clampSql) filters.push(clampSql.replace(/^ AND /, ""));

    const { rows } = await pool.query(
      `SELECT prr.id
         FROM password_reset_requests prr
         JOIN users u ON u.id = prr.user_id
        WHERE ${filters.join(" AND ")}`,
      params,
    );
    if (!rows[0]) throw new HttpError(404, "Password reset request not found");

    const updated = await pool.query(
      `UPDATE password_reset_requests
          SET status = 'resolved', resolved_by = $2, resolved_at = now()
        WHERE id = $1
        RETURNING id, status, resolved_at`,
      [id, req.user!.id],
    );
    await recordAuditLog(pool, {
      agencyId: req.user!.agency_id,
      actorId: req.user!.id,
      action: "password_reset_request.resolve",
      entityType: "password_reset_request",
      entityId: id,
    });
    res.json({ password_reset_request: updated.rows[0] });
  }),
);

export default router;
