import { Router } from "express";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";

const router = Router();
router.use(authenticate, requirePermission("companies.manage"));

/**
 * Backs the dashboard's first-run setup checklist (Phase 5.1). Every step
 * is a real EXISTS check against the agency's own data -- not a client-side
 * guess -- so the checklist can't drift out of sync with what's actually
 * been done, and it disappears on its own once every step is genuinely
 * complete.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const agencyId = req.user!.agency_id;
    const { rows } = await pool.query<{
      company_added: boolean;
      branch_added: boolean;
      employee_added: boolean;
      first_import: boolean;
      allocated: boolean;
    }>(
      `SELECT
         EXISTS(SELECT 1 FROM companies WHERE agency_id = $1) AS company_added,
         EXISTS(SELECT 1 FROM branches WHERE agency_id = $1) AS branch_added,
         EXISTS(SELECT 1 FROM users WHERE agency_id = $1 AND id <> $2) AS employee_added,
         EXISTS(
           SELECT 1 FROM import_runs r JOIN companies c ON c.id = r.company_id
            WHERE c.agency_id = $1
         ) AS first_import,
         EXISTS(
           SELECT 1 FROM customers c JOIN companies co ON co.id = c.company_id
            WHERE co.agency_id = $1 AND c.assigned_agent_id IS NOT NULL
         ) AS allocated`,
      [agencyId, req.user!.id],
    );
    res.json({ steps: rows[0] });
  }),
);

export default router;
