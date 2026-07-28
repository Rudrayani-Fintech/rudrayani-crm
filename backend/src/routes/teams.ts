import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { resolveBranchClamp } from "../services/scope";

const router = Router();
router.use(authenticate);

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  branch_id: z.string().uuid(),
});

async function assertBranchInAgency(branchId: string, agencyId: string): Promise<void> {
  const { rows } = await pool.query("SELECT 1 FROM branches WHERE id = $1 AND agency_id = $2", [
    branchId,
    agencyId,
  ]);
  if (rows.length === 0) throw new HttpError(400, "Branch not found in this agency");
}

// Teams are a pure branch-scoped grouping (Phase 2: no per-team leader --
// every team in a branch reports directly to that branch's branch_manager).
// Phase 9 RBAC sweep (1B.9): GET is left open to any authenticated user in
// the agency, same reasoning as branches.ts/dispositions.ts/buckets.ts --
// team names only, not financial or customer data, and every role needs the
// full list for pickers (allocation, employee assignment, report filters).
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id as string | undefined;
    const { rows: teams } = await pool.query(
      `SELECT t.id, t.name, t.branch_id, b.name AS branch_name, t.created_at
         FROM teams t
         JOIN branches b ON b.id = t.branch_id
        WHERE b.agency_id = $1 AND ($2::uuid IS NULL OR t.branch_id = $2)
        ORDER BY b.name, t.name`,
      [req.user!.agency_id, branchId ?? null],
    );

    res.json({ teams });
  }),
);

router.post(
  "/",
  requirePermission("teams.manage"),
  asyncHandler(async (req, res) => {
    const body = bodySchema.parse(req.body);
    await assertBranchInAgency(body.branch_id, req.user!.agency_id);
    // teams.manage is also granted to branch_manager (Phase 2) --
    // assertBranchInAgency() above only checks agency membership, not "is
    // this the caller's own branch". resolveBranchClamp() returns null for
    // agency_admin/operations_manager (no restriction).
    const clamp = await resolveBranchClamp(req.user!);
    if (clamp && body.branch_id !== clamp.branchId) {
      throw new HttpError(403, "You do not manage this branch");
    }
    const { rows } = await pool.query(
      "INSERT INTO teams (branch_id, name) VALUES ($1, $2) RETURNING id, name, branch_id, created_at",
      [body.branch_id, body.name],
    );
    res.status(201).json({ team: rows[0] });
  }),
);

router.patch(
  "/:id",
  requirePermission("teams.manage"),
  asyncHandler(async (req, res) => {
    const body = bodySchema.partial().parse(req.body);
    if (body.branch_id) await assertBranchInAgency(body.branch_id, req.user!.agency_id);
    const clamp = await resolveBranchClamp(req.user!);
    if (clamp) {
      const { rows: existing } = await pool.query(
        "SELECT branch_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!existing[0]) throw new HttpError(404, "Team not found");
      // Must already manage the team's current branch, and (if moving it)
      // the destination branch too -- never widen to another branch either
      // direction.
      if (existing[0].branch_id !== clamp.branchId) {
        throw new HttpError(403, "You do not manage this team's branch");
      }
      if (body.branch_id && body.branch_id !== clamp.branchId) {
        throw new HttpError(403, "You cannot move a team to a branch you do not manage");
      }
    }
    const { rows } = await pool.query(
      `UPDATE teams t SET
          name = COALESCE($3, t.name),
          branch_id = COALESCE($4, t.branch_id)
        FROM branches b
       WHERE t.id = $1 AND b.id = t.branch_id AND b.agency_id = $2
       RETURNING t.id, t.name, t.branch_id, t.created_at`,
      [req.params.id, req.user!.agency_id, body.name ?? null, body.branch_id ?? null],
    );
    if (!rows[0]) throw new HttpError(404, "Team not found");
    res.json({ team: rows[0] });
  }),
);

export default router;
