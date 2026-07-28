import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { depositTotals, listDeposits } from "../services/report-service";
import { resolveBranchClamp } from "../services/scope";

const router = Router();
router.use(authenticate);

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  branch_manager_id: z.string().uuid().optional().nullable(),
});
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * A branch manager is optional-at-creation, editable later, and one branch
 * per manager (enforced app-side here with a friendly error, and DB-side by
 * the uq_branches_branch_manager_id UNIQUE constraint as a backstop).
 */
export async function assertBranchManager(
  agencyId: string,
  userId: string | null | undefined,
  excludeBranchId?: string,
  client?: any
): Promise<void> {
  if (!userId) return;
  const db = client ?? pool;
  const { rows } = await db.query(
    "SELECT designation, full_name FROM users WHERE id = $1 AND agency_id = $2",
    [userId, agencyId],
  );
  if (rows.length === 0) {
    throw new HttpError(
      400,
      "The selected branch manager could not be found. Please choose someone from the list.",
    );
  }
  if (rows[0].designation !== "branch_manager") {
    throw new HttpError(
      400,
      `${rows[0].full_name} is not a Branch Manager. Change their designation to Branch Manager on the Employees page first, or pick someone who already has that designation.`,
    );
  }
  const { rows: existing } = await db.query(
    "SELECT id, name FROM branches WHERE branch_manager_id = $1",
    [userId],
  );
  if (existing.length > 0 && existing[0].id !== excludeBranchId) {
    throw new HttpError(
      400,
      `${rows[0].full_name} already manages "${existing[0].name}". A Branch Manager can only be responsible for one branch -- remove them from that branch first, or choose someone else.`,
    );
  }
}

// Phase 9 RBAC sweep (1B.9): reviewed and left open to any authenticated
// user in the agency, same reasoning as dispositions.ts/buckets.ts -- this
// returns branch names + manager names, not financial or customer data, and
// branch-scoped roles are already clamped everywhere that matters (customer
// lists, reports, allocation). Every role legitimately needs the full list
// for pickers (assigning an employee, filtering a report by branch, etc.);
// clamping it to the caller's own branch would break those for everyone
// except agency_admin/operations_manager.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.created_at, b.branch_manager_id, bm.full_name AS branch_manager_name
         FROM branches b
         LEFT JOIN users bm ON bm.id = b.branch_manager_id
        WHERE b.agency_id = $1
        ORDER BY b.name`,
      [req.user!.agency_id],
    );
    res.json({ branches: rows });
  }),
);

router.post(
  "/",
  requirePermission("branches.manage"),
  asyncHandler(async (req, res) => {
    const body = bodySchema.parse(req.body);
    await assertBranchManager(req.user!.agency_id, body.branch_manager_id);
    const { rows } = await pool.query(
      `INSERT INTO branches (agency_id, name, branch_manager_id) VALUES ($1, $2, $3)
       RETURNING id, name, created_at, branch_manager_id`,
      [req.user!.agency_id, body.name, body.branch_manager_id ?? null],
    );
    res.status(201).json({ branch: rows[0] });
  }),
);

router.patch(
  "/:id",
  requirePermission("branches.manage"),
  asyncHandler(async (req, res) => {
    // branches.manage is also granted to branch_manager (Phase 2) -- without
    // this clamp they could rename or reassign the manager of ANY branch in
    // the agency, not just their own. resolveBranchClamp() returns null for
    // agency_admin/operations_manager (no restriction).
    const clamp = await resolveBranchClamp(req.user!);
    if (clamp && req.params.id !== clamp.branchId) {
      throw new HttpError(403, "You do not manage this branch");
    }
    const body = bodySchema.partial({ name: true }).parse(req.body);
    if (body.branch_manager_id !== undefined) {
      await assertBranchManager(req.user!.agency_id, body.branch_manager_id, req.params.id);
    }
    const { rows } = await pool.query(
      `UPDATE branches SET
          name = COALESCE($3, name),
          branch_manager_id = CASE WHEN $4::boolean THEN $5::uuid ELSE branch_manager_id END
        WHERE id = $1 AND agency_id = $2
        RETURNING id, name, created_at, branch_manager_id`,
      [
        req.params.id,
        req.user!.agency_id,
        body.name ?? null,
        body.branch_manager_id !== undefined,
        body.branch_manager_id ?? null,
      ],
    );
    if (!rows[0]) throw new HttpError(404, "Branch not found");
    res.json({ branch: rows[0] });
  }),
);

/**
 * Branch drill-down (Phase 9): one aggregating fetch behind the BranchesPage
 * drawer -- team details, targets, and deposits for this branch. Agent-wise
 * breakdown is deliberately NOT duplicated here: the frontend embeds the
 * existing BreakdownTable widget (dimension=agent, branch_id=this branch),
 * which already hits GET /reports/breakdown on its own.
 * Gated the same as the Branches nav item itself (branches.manage) -- but
 * that permission is also granted to branch_manager (Phase 2), so this is
 * NOT always agency-wide: a branch_manager caller is clamped to their own
 * branch below (resolveBranchClamp() returns null, i.e. no restriction, for
 * agency_admin/operations_manager).
 */
router.get(
  "/:id",
  requirePermission("branches.manage"),
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const clamp = await resolveBranchClamp(req.user!);
    if (clamp && id !== clamp.branchId) {
      throw new HttpError(403, "You do not manage this branch");
    }
    const query = z
      .object({ month: z.string().regex(MONTH_RE, "month must be YYYY-MM").optional() })
      .parse(req.query);
    const agencyId = req.user!.agency_id;
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    const { rows: branchRows } = await pool.query(
      `SELECT b.id, b.name, b.created_at, b.branch_manager_id, bm.full_name AS branch_manager_name
         FROM branches b
         LEFT JOIN users bm ON bm.id = b.branch_manager_id
        WHERE b.id = $1 AND b.agency_id = $2`,
      [id, agencyId],
    );
    const branch = branchRows[0];
    if (!branch) throw new HttpError(404, "Branch not found");

    const [teamsRes, agentCountRes, targetsRes, deposits, depositPayments] = await Promise.all([
      pool.query(
        `SELECT t.id, t.name, t.created_at,
                COUNT(DISTINCT u.id) FILTER (WHERE u.is_active)::int AS member_count
           FROM teams t
           LEFT JOIN users u ON u.team_id = t.id
          WHERE t.branch_id = $1
          GROUP BY t.id
          ORDER BY t.name`,
        [id],
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE branch_id = $1 AND is_active`, [id]),
      pool.query(
        `SELECT t.id, t.metric, t.target_amount, t.target_count, t.product, t.bucket,
                co.name AS company_name
           FROM targets t
           LEFT JOIN companies co ON co.id = t.company_id
          WHERE t.agency_id = $1 AND t.scope_type = 'branch' AND t.scope_id = $2
            AND t.month = $3::date
          ORDER BY t.metric`,
        [agencyId, id, monthStart],
      ),
      depositTotals(agencyId, { month: monthStart, branch_id: id }),
      listDeposits(agencyId, { month: monthStart, branch_id: id, limit: 200 }),
    ]);

    res.json({
      branch,
      month,
      teams: teamsRes.rows,
      team_count: teamsRes.rows.length,
      agent_count: agentCountRes.rows[0].n,
      targets: targetsRes.rows,
      deposits: { ...deposits, payments: depositPayments },
    });
  }),
);

export default router;
