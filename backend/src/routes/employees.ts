import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { hashPassword } from "../services/auth-service";
import { capabilitiesHavePermission } from "../services/permission-service";
import { dimensionBreakdown, type BreakdownRow } from "../services/report-service";
import { assertBranchManager } from "./branches";
import { getSmsProvider } from "../services/sms/sms-provider";
import { recordAuditLog } from "../services/audit-log-service";
import { logger } from "../config/logger";
import { resolveBranchClamp } from "../services/scope";
import {
  capabilitiesOf,
  publicUser,
  booleansForDesignation,
  type UserRow,
  type Capability,
  type AgentType,
} from "../types/user";

const router = Router();
router.use(authenticate);

const designationSchema = z.enum(["operations_manager", "branch_manager", "telecaller", "field_agent"]);

const agentTypeSchema = z.enum(["telecaller", "field_agent"]);

const createSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  phone: z.string().length(10).regex(/^\d{10}$/, "Phone must be exactly 10 digits"),
  email: z.string().email().optional().nullable(),
  password: z.string().min(8),
  branch_id: z.string().uuid().optional().nullable(),
  team_id: z.string().uuid().optional().nullable(),
  manager_id: z.string().uuid().optional().nullable(),
  designation: designationSchema,
  agent_type: agentTypeSchema.optional().nullable(),
  managed_branch_id: z.string().uuid().optional().nullable(),
});

const updateSchema = z.object({
  full_name: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().optional().nullable(),
  branch_id: z.string().uuid().optional().nullable(),
  team_id: z.string().uuid().optional().nullable(),
  manager_id: z.string().uuid().optional().nullable(),
  is_active: z.boolean().optional(),
  designation: designationSchema.optional(),
  agent_type: agentTypeSchema.optional().nullable(),
  managed_branch_id: z.string().uuid().optional().nullable(),
});

/** Human-readable names for error messages -- never surface raw enum values to users. */
const DESIGNATION_LABELS: Record<Capability, string> = {
  agency_admin: "Agency Admin",
  operations_manager: "Operations Manager",
  branch_manager: "Branch Manager",
  telecaller: "Telecaller",
  field_agent: "Field Agent",
};
const label = (d: string): string => DESIGNATION_LABELS[d as Capability] ?? d;

/**
 * Brief Section 3 rules:
 *  - There is exactly one Agency Admin; it can never be granted through the API
 *    (bootstrap script only), so `is_agency_admin` is not even accepted here.
 *  - Granting or revoking Operations Manager requires the ops_managers.create
 *    permission — which only the Agency Admin capability holds.
 */
async function assertCanEditOpsManager(actor: UserRow, designation?: Capability): Promise<void> {
  // Only check if setting designation to operations_manager
  if (designation === "operations_manager") {
    const allowed = await capabilitiesHavePermission(capabilitiesOf(actor), "ops_managers.create");
    if (!allowed) {
      throw new HttpError(
        403,
        "Only the Agency Admin can create or edit Operations Managers. Ask your Agency Admin to make this change.",
      );
    }
  }
}

/**
 * Best-effort: an employee (or their password reset) is useless until they
 * actually know the phone+password to log in with -- the exact confusion
 * that prompted this. Never let an SMS failure block account creation.
 */
async function notifyCredentials(phone: string, password: string, isReset: boolean): Promise<void> {
  try {
    const action = isReset ? "Your Rudrayani CRM password has been reset." : "Your Rudrayani CRM account is ready.";
    await getSmsProvider().sendSms(
      phone,
      `${action} Login with phone ${phone} and password ${password} on the web portal or mobile app. Please change your password after logging in.`,
    );
  } catch (err) {
    logger.warn({ err, phone }, "Failed to send employee credentials SMS (account/reset still succeeded)");
  }
}

/**
 * Phase 2: a branch must have a branch_manager before it can carry
 * telecaller/field_agent staff -- there's no team_leader anymore to
 * independently supervise an unmanaged branch, so an agent placed there
 * would end up with no valid manager at all per EXPECTED_MANAGER_DESIGNATION.
 * Takes a list since telecaller-type work can span multiple branches (the
 * multi-branch picker) -- every one of them must be managed, not just one.
 */
async function assertBranchesHaveManager(agencyId: string, branchIds: string[]): Promise<void> {
  if (branchIds.length === 0) return;
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM branches WHERE agency_id = $1 AND id = ANY($2) AND branch_manager_id IS NULL",
    [agencyId, branchIds],
  );
  if (rows.length > 0) {
    const names = rows.map((r) => r.name).join(", ");
    throw new HttpError(
      400,
      `"${names}" doesn't have a Branch Manager yet. Assign a Branch Manager to this branch before adding agents to it.`,
    );
  }
}

async function assertBranchAndTeam(
  agencyId: string,
  branchId: string | null | undefined,
  teamId: string | null | undefined,
): Promise<void> {
  if (branchId) {
    const { rows } = await pool.query("SELECT 1 FROM branches WHERE id = $1 AND agency_id = $2", [
      branchId,
      agencyId,
    ]);
    if (rows.length === 0) {
      throw new HttpError(400, "The selected branch could not be found. Please choose a branch from the list.");
    }
  }
  if (teamId) {
    const { rows } = await pool.query(
      `SELECT t.branch_id FROM teams t JOIN branches b ON b.id = t.branch_id
        WHERE t.id = $1 AND b.agency_id = $2`,
      [teamId, agencyId],
    );
    if (rows.length === 0) {
      throw new HttpError(400, "The selected team could not be found. Please choose a team from the list.");
    }
    if (branchId && rows[0].branch_id !== branchId) {
      throw new HttpError(
        400,
        "The selected team belongs to a different branch. Choose a team from the selected branch, or clear the branch first.",
      );
    }
  }
}

/**
 * Hard hierarchy enforcement: non-admin designations MUST have a manager
 * whose designation is exactly the next rank up in the fixed chain:
 * - operations_manager → manager is agency_admin (via assertCanEditOpsManager)
 * - telecaller / field_agent → manager is branch_manager
 * - agency_admin → no manager allowed
 *
 * Forward-only enforcement: only validates when designation or manager_id
 * is part of the write payload, not on every unrelated edit.
 */
// Phase 2: team_leader is gone -- every team in a branch reports directly
// to that branch's branch_manager now, no intermediary rank. branch_manager
// itself still reports to operations_manager (unchanged since Phase 1).
const EXPECTED_MANAGER_DESIGNATION: Record<Capability, Capability> = {
  operations_manager: "agency_admin",
  branch_manager: "operations_manager",
  telecaller: "branch_manager",
  field_agent: "branch_manager",
  agency_admin: "agency_admin", // unreachable but needed for type completeness
};

async function assertManager(
  agencyId: string,
  designation: Capability | null,
  managerId: string | null | undefined,
  selfId?: string,
): Promise<void> {
  if (!designation || designation === "agency_admin") {
    // Admin requires no manager
    if (managerId) {
      throw new HttpError(
        400,
        "Agency Admin is the top of the hierarchy and cannot report to anyone. Clear the \"Reports to\" field to continue.",
      );
    }
    return;
  }

  // Look up this designation's required manager rank up front so every
  // message below can say exactly what to pick, not just what's wrong.
  const requiredDesignation = EXPECTED_MANAGER_DESIGNATION[designation];

  if (!managerId) {
    throw new HttpError(
      400,
      `A ${label(designation)} must report to a manager. Select a ${label(requiredDesignation)} in "Reports to" before saving.`,
    );
  }

  if (selfId && managerId === selfId) {
    throw new HttpError(
      400,
      "An employee cannot report to themselves. Choose a different manager in \"Reports to\".",
    );
  }

  const { rows } = await pool.query<{ designation: string }>(
    "SELECT designation FROM users WHERE id = $1 AND agency_id = $2",
    [managerId, agencyId],
  );

  if (rows.length === 0) {
    throw new HttpError(
      400,
      "The selected manager could not be found. Please pick another manager from the list.",
    );
  }

  if (rows[0].designation !== requiredDesignation) {
    throw new HttpError(
      400,
      `You selected ${label(rows[0].designation)} as the manager, but a ${label(designation)} must report ` +
        `to a ${label(requiredDesignation)} directly. Please select a ${label(requiredDesignation)} in "Reports to" instead.`,
    );
  }
}

/**
 * agent_type lets a branch_manager ALSO carry collections work (telecaller-
 * type or field-agent-type) alongside their management rank -- "additional
 * responsibilities, the core work remains the same." Returns the value that
 * should actually be written.
 *  - telecaller/field_agent designations: agent_type must mirror designation
 *    if provided; the server always writes the mirrored value regardless
 *    (never trusts a client-supplied mismatch).
 *  - branch_manager: agent_type may be null, "telecaller", or "field_agent",
 *    freely client-settable.
 *  - agency_admin/operations_manager: agent_type must be null/omitted.
 */
function assertAgentType(
  designation: Capability,
  agentType: AgentType | null | undefined,
): AgentType | null {
  if (designation === "telecaller" || designation === "field_agent") {
    if (agentType !== undefined && agentType !== null && agentType !== designation) {
      throw new HttpError(
        400,
        `A ${label(designation)}'s work type is always "${label(designation)}" -- it's set automatically and doesn't need to be chosen separately.`,
      );
    }
    return designation;
  }
  if (designation === "branch_manager") {
    return agentType ?? null;
  }
  // agency_admin / operations_manager
  if (agentType) {
    throw new HttpError(
      400,
      `${label(designation)} is a management-only role and cannot also do collections work. Remove the "Also does collections work as" selection.`,
    );
  }
  return null;
}

/**
 * branch_ids/team_ids are write-only via PUT /:id/branches and /:id/teams
 * (junction tables, not columns on users) -- without this, an edit form
 * re-opening a telecaller-type employee would only ever see their single
 * scalar branch_id/team_id, silently losing every other assignment. Batches
 * one query per table across the whole result set rather than N+1.
 */
async function attachMultiAssignments<T extends { id: string; designation: string; agent_type: string | null }>(
  users: T[],
): Promise<(T & { branch_ids?: string[]; team_ids?: string[] })[]> {
  const telecallerTypeIds = users
    .filter((u) => u.designation === "telecaller" || u.agent_type === "telecaller")
    .map((u) => u.id);
  if (telecallerTypeIds.length === 0) return users;

  const [{ rows: branchRows }, { rows: teamRows }] = await Promise.all([
    pool.query<{ user_id: string; branch_id: string }>(
      "SELECT user_id, branch_id FROM telecaller_branches WHERE user_id = ANY($1::uuid[])",
      [telecallerTypeIds],
    ),
    pool.query<{ user_id: string; team_id: string }>(
      "SELECT user_id, team_id FROM telecaller_teams WHERE user_id = ANY($1::uuid[])",
      [telecallerTypeIds],
    ),
  ]);
  const branchesByUser = new Map<string, string[]>();
  for (const r of branchRows) {
    if (!branchesByUser.has(r.user_id)) branchesByUser.set(r.user_id, []);
    branchesByUser.get(r.user_id)!.push(r.branch_id);
  }
  const teamsByUser = new Map<string, string[]>();
  for (const r of teamRows) {
    if (!teamsByUser.has(r.user_id)) teamsByUser.set(r.user_id, []);
    teamsByUser.get(r.user_id)!.push(r.team_id);
  }

  return users.map((u) =>
    telecallerTypeIds.includes(u.id)
      ? { ...u, branch_ids: branchesByUser.get(u.id) ?? [], team_ids: teamsByUser.get(u.id) ?? [] }
      : u,
  );
}

async function attachManagedBranch<T extends { id: string; designation: string }>(
  users: T[],
): Promise<(T & { managed_branch_id?: string | null })[]> {
  const branchManagerIds = users.filter((u) => u.designation === "branch_manager").map((u) => u.id);
  if (branchManagerIds.length === 0) return users;

  const { rows } = await pool.query<{ id: string; branch_manager_id: string }>(
    "SELECT id, branch_manager_id FROM branches WHERE branch_manager_id = ANY($1::uuid[])",
    [branchManagerIds],
  );

  const managedBranchByUser = new Map<string, string>();
  for (const r of rows) {
    managedBranchByUser.set(r.branch_manager_id, r.id);
  }

  return users.map((u) =>
    u.designation === "branch_manager" ? { ...u, managed_branch_id: managedBranchByUser.get(u.id) ?? null } : u,
  );
}

router.get(
  "/",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const branchId = req.query.branch_id as string | undefined;
    const teamId = req.query.team_id as string | undefined;
    const designation = req.query.designation as string | undefined;
    const customerBranch = req.query.customer_branch as string | undefined;
    const product = req.query.product as string | undefined;
    // Phase 12 (Management Dashboard "Active Agents" KPI): lets the client
    // get a pre-filtered count instead of fetching everyone and filtering
    // client-side. Omitted -> unfiltered (unchanged pre-Phase-12 behavior).
    const isActiveRaw = req.query.is_active as string | undefined;
    const isActive = isActiveRaw === undefined ? null : isActiveRaw === "true";
    // Allocation's agent picker (AllocationPage.tsx) is otherwise blind --
    // an agent with 400 accounts and one with 4 look identical in the
    // dropdown. Opt-in and computed only when asked for, so the plain
    // employee-list/table view (EmployeesPage) doesn't pay for an extra
    // correlated subquery per row on every load.
    const withLoad = req.query.with_load === "true";

    // A branch_manager's branch filter is forced to their own branch,
    // overriding whatever (if anything) the client asked for -- the client
    // param stays purely optional for agency_admin/operations_manager.
    const clamp = await resolveBranchClamp(req.user!);
    const effectiveBranchId = clamp ? clamp.branchId : (branchId ?? null);

    const params: unknown[] = [
      req.user!.agency_id,
      effectiveBranchId,
      teamId ?? null,
      q || null,
      isActive,
      designation ?? null,
    ];

    // Missing the telecaller_branches junction (unlike agentBranchClamp() in
    // scope.ts, which every other branch-scoped route goes through) meant a
    // multi-branch telecaller assigned to this branch via the junction table
    // -- but whose own scalar branch_id points elsewhere -- silently didn't
    // show up here, including in the dashboard's agent-picker dropdown.
    let conditions = `WHERE u.agency_id = $1
          AND ($2::uuid IS NULL OR u.branch_id = $2
            OR EXISTS (SELECT 1 FROM branches mb WHERE mb.branch_manager_id = u.id AND mb.id = $2)
            OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = u.id AND tb.branch_id = $2))
          AND ($3::uuid IS NULL OR u.team_id = $3)
          AND ($4::text IS NULL OR u.full_name ILIKE '%' || $4 || '%' OR u.phone LIKE $4 || '%')
          AND ($5::boolean IS NULL OR u.is_active = $5)
          AND ($6::text IS NULL OR u.designation = $6)`;

    if (customerBranch) {
      params.push(customerBranch);
      const n = params.length;
      conditions += ` AND EXISTS (SELECT 1 FROM customers c WHERE (c.assigned_agent_id = u.id OR c.assigned_field_agent_id = u.id) AND (c.branch_id::text = $${n} OR (c.branch_id IS NULL AND (c.custom_fields->>'branch' ILIKE '%' || $${n} || '%' OR c.custom_fields->>'Branch' ILIKE '%' || $${n} || '%'))))`;
    }
    if (product) {
      params.push(product);
      conditions += ` AND EXISTS (SELECT 1 FROM customers c WHERE (c.assigned_agent_id = u.id OR c.assigned_field_agent_id = u.id) AND c.product = $${params.length})`;
    }

    const loadSelect = withLoad
      ? `, (SELECT COUNT(*) FROM customers c WHERE (c.assigned_agent_id = u.id OR c.assigned_field_agent_id = u.id) AND c.status = 'active') AS assigned_count`
      : "";
    const { rows } = await pool.query<UserRow & { manager_name: string | null; assigned_count?: string }>(
      `SELECT u.*, m.full_name as manager_name${loadSelect} FROM users u LEFT JOIN users m ON u.manager_id = m.id ${conditions} ORDER BY u.full_name`,
      params,
    );
    const withMulti = await attachMultiAssignments(rows);
    const withManaged = await attachManagedBranch(withMulti);
    res.json({
      employees: withManaged.map((u) => ({
        ...publicUser(u),
        is_active: u.is_active,
        branch_ids: u.branch_ids,
        team_ids: u.team_ids,
        managed_branch_id: u.managed_branch_id,
        manager_name: u.manager_name,
        ...(withLoad ? { assigned_count: Number(u.assigned_count ?? 0) } : {}),
      })),
    });
  }),
);

router.post(
  "/",
  requirePermission("employees.create"),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    await assertCanEditOpsManager(req.user!, body.designation);

    // A branch_manager holds employees.create for their own team, not for
    // the org structure itself -- they can only add individual contributors
    // to their own branch, not another management rank or someone else's
    // branch (customers.allocate's sibling gap, same audit pass).
    const clamp = await resolveBranchClamp(req.user!);
    if (clamp) {
      if (body.designation === "operations_manager" || body.designation === "branch_manager") {
        throw new HttpError(
          403,
          "A Branch Manager can only add Telecallers or Field Agents. Creating another Branch Manager or Operations Manager requires Operations Manager or Agency Admin access.",
        );
      }
      if (body.branch_id && body.branch_id !== clamp.branchId) {
        throw new HttpError(403, "A Branch Manager can only add employees to their own branch.");
      }
    }

    const agentType = assertAgentType(body.designation as Capability, body.agent_type);
    await assertBranchAndTeam(req.user!.agency_id, body.branch_id, body.team_id);
    if (body.branch_id && (body.designation === "telecaller" || body.designation === "field_agent")) {
      await assertBranchesHaveManager(req.user!.agency_id, [body.branch_id]);
    }
    await assertManager(req.user!.agency_id, body.designation as Capability, body.manager_id);

    const client = await pool.connect();
    let createdUser: UserRow;
    try {
      await client.query("BEGIN");
      
      if (body.designation === "branch_manager" && body.managed_branch_id) {
        // Run assertBranchManager with the transaction client to ensure it locks/reads fresh data
        await assertBranchManager(req.user!.agency_id, null, undefined, client); // Wait, this just checks if the user IS a branch manager, but they don't exist yet!
        // Actually, we need to check if the target branch ALREADY has a manager
        const { rows: existingManager } = await client.query<{ id: string; branch_manager_id: string | null }>(
          "SELECT id, branch_manager_id FROM branches WHERE id = $1 AND agency_id = $2 FOR UPDATE",
          [body.managed_branch_id, req.user!.agency_id],
        );
        if (existingManager.length === 0) {
          throw new HttpError(400, "The selected managed branch could not be found.");
        }
        if (existingManager[0].branch_manager_id) {
          throw new HttpError(
            400,
            "The selected branch already has a Branch Manager. A branch can only have one manager.",
          );
        }
      } else if (body.designation !== "branch_manager" && body.managed_branch_id) {
        throw new HttpError(400, "Only Branch Managers can be assigned a managed branch.");
      }

      const passwordHash = await hashPassword(body.password);
      const booleans = booleansForDesignation(body.designation, agentType);
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users
           (agency_id, full_name, phone, email, password_hash, branch_id, team_id, manager_id, designation, agent_type,
            is_operations_manager, is_telecaller, is_field_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          req.user!.agency_id,
          body.full_name,
          body.phone,
          body.email ?? null,
          passwordHash,
          body.branch_id ?? null,
          body.team_id ?? null,
          body.manager_id ?? null,
          body.designation,
          agentType,
          booleans.is_operations_manager,
          booleans.is_telecaller,
          booleans.is_field_agent,
        ],
      );
      createdUser = rows[0];

      if (body.designation === "branch_manager" && body.managed_branch_id) {
        await client.query(
          "UPDATE branches SET branch_manager_id = $1 WHERE id = $2 AND agency_id = $3",
          [createdUser.id, body.managed_branch_id, req.user!.agency_id],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await notifyCredentials(body.phone, body.password, false);
    res.status(201).json({ employee: { ...publicUser(createdUser), is_active: createdUser.is_active, managed_branch_id: body.managed_branch_id ?? null } });
  }),
);

/**
 * Org chart data: agency -> branches -> teams -> agents, with each agent's
 * manager_id/manager_name attached so the frontend can draw report-to edges
 * within a team (or a branch's/agency's "unassigned" bucket). Registered
 * ahead of GET /:id so "org-hierarchy" isn't swallowed as a :id param.
 */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

router.get(
  "/org-hierarchy",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const agencyId = req.user!.agency_id;
    const query = z
      .object({
        with_performance: z
          .union([z.literal("true"), z.literal("false")])
          .optional()
          .transform((v) => v === "true"),
        month: z.string().regex(MONTH_RE, "month must be YYYY-MM").optional(),
      })
      .parse(req.query);

    // A branch_manager only ever sees their own branch's org tree -- the
    // whole point of "org chart," so this can't be left agency-wide like the
    // other queries below it used to be.
    const clamp = await resolveBranchClamp(req.user!);

    const { rows: agencyRows } = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM agencies WHERE id = $1",
      [agencyId],
    );

    const branchParams: unknown[] = [agencyId];
    let branchClampSql = "";
    if (clamp) {
      branchParams.push(clamp.branchId);
      branchClampSql = ` AND id = $${branchParams.length}`;
    }
    const { rows: branches } = await pool.query<{ id: string; name: string; branch_manager_id: string | null }>(
      `SELECT id, name, branch_manager_id FROM branches WHERE agency_id = $1${branchClampSql} ORDER BY name`,
      branchParams,
    );

    const teamParams: unknown[] = [agencyId];
    let teamClampSql = "";
    if (clamp) {
      teamParams.push(clamp.branchId);
      teamClampSql = ` AND b.id = $${teamParams.length}`;
    }
    const { rows: teams } = await pool.query<{ id: string; name: string; branch_id: string }>(
      `SELECT t.id, t.name, t.branch_id FROM teams t
         JOIN branches b ON b.id = t.branch_id
        WHERE b.agency_id = $1${teamClampSql}
        ORDER BY t.name`,
      teamParams,
    );

    const userParams: unknown[] = [agencyId];
    let userClampSql = "";
    if (clamp) {
      userParams.push(clamp.branchId);
      const n = userParams.length;
      userClampSql = ` AND (u.branch_id = $${n} OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = u.id AND tb.branch_id = $${n}) OR EXISTS (SELECT 1 FROM branches mb WHERE mb.branch_manager_id = u.id AND mb.id = $${n}))`;
    }
    const { rows: users } = await pool.query<UserRow>(
      `SELECT u.* FROM users u WHERE u.agency_id = $1${userClampSql} ORDER BY u.full_name`,
      userParams,
    );

    const nameById = new Map(users.map((u) => [u.id, u.full_name]));
    const toAgent = (u: UserRow) => ({
      ...publicUser(u),
      is_active: u.is_active,
      manager_name: u.manager_id ? (nameById.get(u.manager_id) ?? null) : null,
    });

    // Reuse-first: performance numbers come straight from the same
    // dimensionBreakdown() that already powers /reports/breakdown -- no
    // bespoke aggregation here. Opt-in via ?with_performance=true so plain
    // roster callers (existing OrgChartPage usage) are unaffected.
    let perfByBranch = new Map<string, BreakdownRow>();
    let perfByTeam = new Map<string, BreakdownRow>();
    let perfByAgent = new Map<string, BreakdownRow>();
    if (query.with_performance) {
      const month = query.month ?? new Date().toISOString().slice(0, 7);
      const filters = { month: `${month}-01` };
      const [branchRows, teamRows, agentRows] = await Promise.all([
        dimensionBreakdown(req.user!, filters, true, "branch"),
        dimensionBreakdown(req.user!, filters, true, "team"),
        dimensionBreakdown(req.user!, filters, true, "agent"),
      ]);
      perfByBranch = new Map(branchRows.filter((r) => r.key).map((r) => [r.key as string, r]));
      perfByTeam = new Map(teamRows.filter((r) => r.key).map((r) => [r.key as string, r]));
      perfByAgent = new Map(agentRows.filter((r) => r.key).map((r) => [r.key as string, r]));
    }
    const perfFor = (map: Map<string, BreakdownRow>, key: string) => {
      const row = map.get(key);
      if (!row) return undefined;
      return {
        collected_amount: row.collected_amount,
        target_amount: row.target_amount,
        achievement_pct: row.achievement_pct,
      };
    };

    // branch_manager is a management rank, not a plain team member --
    // exclude from team/branch agent lists.
    const isPlainAgent = (u: UserRow) => u.designation !== "branch_manager";

    const branchTree = branches.map((b) => ({
      id: b.id,
      name: b.name,
      branch_manager: b.branch_manager_id
        ? { id: b.branch_manager_id, full_name: nameById.get(b.branch_manager_id) ?? null }
        : null,
      ...(query.with_performance ? { performance: perfFor(perfByBranch, b.id) ?? null } : {}),
      teams: teams
        .filter((t) => t.branch_id === b.id)
        .map((t) => {
          const agentsInTeam = users.filter((u) => u.team_id === t.id);
          return {
            id: t.id,
            name: t.name,
            ...(query.with_performance ? { performance: perfFor(perfByTeam, t.id) ?? null } : {}),
            agents: agentsInTeam.map((u) => ({
              ...toAgent(u),
              ...(query.with_performance ? { performance: perfFor(perfByAgent, u.id) ?? null } : {}),
            })),
          };
        }),
      unassigned_agents: users.filter((u) => u.branch_id === b.id && !u.team_id && isPlainAgent(u)).map(toAgent),
    }));

    const agencyUnassigned = users.filter((u) => !u.branch_id && isPlainAgent(u)).map(toAgent);

    res.json({
      agency: agencyRows[0] ?? null,
      branches: branchTree,
      unassigned_agents: agencyUnassigned,
    });
  }),
);

router.get(
  "/:id",
  requirePermission("employees.view"),
  asyncHandler(async (req, res) => {
    const clamp = await resolveBranchClamp(req.user!);
    const params: unknown[] = [req.params.id, req.user!.agency_id];
    let branchClampSql = "";
    if (clamp) {
      params.push(clamp.branchId);
      const n = params.length;
      branchClampSql = ` AND (u.branch_id = $${n} OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = u.id AND tb.branch_id = $${n}) OR EXISTS (SELECT 1 FROM branches mb WHERE mb.branch_manager_id = u.id AND mb.id = $${n}))`;
    }
    const { rows } = await pool.query<UserRow>(
      `SELECT u.* FROM users u WHERE u.id = $1 AND u.agency_id = $2${branchClampSql}`,
      params,
    );
    if (!rows[0]) throw new HttpError(404, "Employee not found");
    const [withMulti] = await attachMultiAssignments(rows);
    const [withManaged] = await attachManagedBranch([withMulti]);
    res.json({
      employee: {
        ...publicUser(withManaged),
        is_active: withManaged.is_active,
        branch_ids: withManaged.branch_ids,
        team_ids: withManaged.team_ids,
        managed_branch_id: withManaged.managed_branch_id,
      },
    });
  }),
);

router.patch(
  "/:id",
  requirePermission("employees.update"),
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const { rows: existingRows } = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1 AND agency_id = $2",
      [req.params.id, req.user!.agency_id],
    );
    const existing = existingRows[0];
    if (!existing) throw new HttpError(404, "Employee not found");
    if (existing.is_agency_admin) {
      throw new HttpError(403, "The Agency Admin account cannot be modified here");
    }

    if (body.designation) {
      await assertCanEditOpsManager(req.user!, body.designation);
    }

    // Recompute agent_type whenever designation or agent_type itself changes
    // -- the effective designation determines what agent_type values are
    // even valid (see assertAgentType()).
    const agentTypeChanging = body.designation !== undefined || body.agent_type !== undefined;
    let newAgentType: AgentType | null = existing.agent_type;
    if (agentTypeChanging) {
      const effectiveDesignation = (body.designation ?? existing.designation) as Capability;
      const isAgentDesignation = effectiveDesignation === "telecaller" || effectiveDesignation === "field_agent";
      // telecaller/field_agent always auto-mirror their own agent_type
      // regardless of history, so a stale existing.agent_type left over from
      // a *different* prior designation must never be treated as an explicit
      // (and possibly conflicting) request here -- e.g. changing a telecaller
      // to a field_agent without resending agent_type would otherwise compare
      // the new "field_agent" designation against the old "telecaller" value
      // and wrongly reject the edit. branch_manager still carries the
      // existing value over unless the client overrides it.
      const requestedAgentType =
        body.agent_type !== undefined ? body.agent_type : isAgentDesignation ? undefined : existing.agent_type;
      newAgentType = assertAgentType(effectiveDesignation, requestedAgentType);
    }

    if (body.is_active === false) {
      const allowed = await capabilitiesHavePermission(
        capabilitiesOf(req.user!),
        "employees.deactivate",
      );
      if (!allowed) throw new HttpError(403, "Missing permission: employees.deactivate");
    }

    await assertBranchAndTeam(
      req.user!.agency_id,
      body.branch_id ?? existing.branch_id,
      body.team_id ?? existing.team_id,
    );
    {
      const effectiveDesignation = (body.designation ?? existing.designation) as Capability;
      const effectiveBranchId = body.branch_id ?? existing.branch_id;
      if (effectiveBranchId && (effectiveDesignation === "telecaller" || effectiveDesignation === "field_agent")) {
        await assertBranchesHaveManager(req.user!.agency_id, [effectiveBranchId]);
      }
    }
    // Validate hierarchy only if designation or manager_id is being changed
    if (body.manager_id !== undefined || body.designation) {
      const designation = (body.designation ?? existing.designation) as Capability;
      const managerId = body.manager_id !== undefined ? body.manager_id : existing.manager_id;
      await assertManager(req.user!.agency_id, designation, managerId, existing.id);
    }

    const booleans = agentTypeChanging
      ? booleansForDesignation((body.designation ?? existing.designation) as Capability, newAgentType)
      : null;

    const client = await pool.connect();
    let updatedUser: UserRow;
    let managedBranchIdToReturn: string | null = null;
    try {
      await client.query("BEGIN");

      const effectiveDesignation = (body.designation ?? existing.designation) as Capability;
      const isActive = body.is_active !== undefined ? body.is_active : existing.is_active;
      const isEligibleManager = effectiveDesignation === "branch_manager" && isActive;
      
      if (!isEligibleManager) {
        // If they are no longer an active branch manager, clear their branch management
        await client.query(
          "UPDATE branches SET branch_manager_id = NULL WHERE branch_manager_id = $1 AND agency_id = $2",
          [req.params.id, req.user!.agency_id],
        );
      } else if (body.managed_branch_id !== undefined) {
        // Only modify if managed_branch_id is explicitly sent
        if (body.managed_branch_id === null) {
          await client.query(
            "UPDATE branches SET branch_manager_id = NULL WHERE branch_manager_id = $1 AND agency_id = $2",
            [req.params.id, req.user!.agency_id],
          );
        } else {
          // Check if target branch exists and is available
          const { rows: targetBranch } = await client.query<{ id: string; branch_manager_id: string | null }>(
            "SELECT id, branch_manager_id FROM branches WHERE id = $1 AND agency_id = $2 FOR UPDATE",
            [body.managed_branch_id, req.user!.agency_id],
          );
          if (targetBranch.length === 0) {
            throw new HttpError(400, "The selected managed branch could not be found.");
          }
          if (targetBranch[0].branch_manager_id && targetBranch[0].branch_manager_id !== req.params.id) {
            throw new HttpError(
              400,
              "The selected branch already has a Branch Manager. A branch can only have one manager.",
            );
          }
          
          // Clear their old branch if they had one
          await client.query(
            "UPDATE branches SET branch_manager_id = NULL WHERE branch_manager_id = $1 AND agency_id = $2 AND id != $3",
            [req.params.id, req.user!.agency_id, body.managed_branch_id],
          );
          // Set new branch
          await client.query(
            "UPDATE branches SET branch_manager_id = $1 WHERE id = $2 AND agency_id = $3",
            [req.params.id, body.managed_branch_id, req.user!.agency_id],
          );
          managedBranchIdToReturn = body.managed_branch_id;
        }
      } else {
         // managed_branch_id not sent, preserve existing
         const { rows: existingBranch } = await client.query<{ id: string }>(
           "SELECT id FROM branches WHERE branch_manager_id = $1 AND agency_id = $2",
           [req.params.id, req.user!.agency_id],
         );
         managedBranchIdToReturn = existingBranch.length > 0 ? existingBranch[0].id : null;
      }

      const teamChanged = body.team_id !== undefined && body.team_id !== existing.team_id;
      const branchChanged = body.branch_id !== undefined && body.branch_id !== existing.branch_id;
      const deactivated = body.is_active === false && existing.is_active;

      if (deactivated || teamChanged || branchChanged) {
        await client.query(
          `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason, slot)
           SELECT id, assigned_agent_id, NULL, $2, 'Agent moved or deactivated', 'primary'
           FROM customers WHERE assigned_agent_id = $1`,
          [req.params.id, req.user!.id]
        );
        
        await client.query(
          `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason, slot)
           SELECT id, assigned_field_agent_id, NULL, $2, 'Agent moved or deactivated', 'secondary'
           FROM customers WHERE assigned_field_agent_id = $1`,
          [req.params.id, req.user!.id]
        );

        await client.query("UPDATE customers SET assigned_agent_id = NULL WHERE assigned_agent_id = $1", [req.params.id]);
        await client.query("UPDATE customers SET assigned_field_agent_id = NULL WHERE assigned_field_agent_id = $1", [req.params.id]);
      }

      const { rows } = await client.query<UserRow>(
        `UPDATE users SET
            full_name = COALESCE($3, full_name),
            email = COALESCE($4, email),
            branch_id = CASE WHEN $5::boolean THEN $6::uuid ELSE branch_id END,
            team_id = CASE WHEN $7::boolean THEN $8::uuid ELSE team_id END,
            manager_id = CASE WHEN $10::boolean THEN $11::uuid ELSE manager_id END,
            designation = COALESCE($12, designation),
            agent_type = CASE WHEN $16::boolean THEN $17::text ELSE agent_type END,
            is_active = COALESCE($9, is_active),
            is_operations_manager = CASE WHEN $12::text IS NOT NULL THEN $13::boolean ELSE is_operations_manager END,
            is_telecaller = CASE WHEN $16::boolean THEN $14::boolean ELSE is_telecaller END,
            is_field_agent = CASE WHEN $16::boolean THEN $15::boolean ELSE is_field_agent END
          WHERE id = $1 AND agency_id = $2
          RETURNING *`,
        [
          req.params.id,
          req.user!.agency_id,
          body.full_name ?? null,
          body.email ?? null,
          body.branch_id !== undefined,
          body.branch_id ?? null,
          body.team_id !== undefined,
          body.team_id ?? null,
          body.is_active ?? null,
          body.manager_id !== undefined,
          body.manager_id ?? null,
          body.designation ?? null,
          booleans?.is_operations_manager ?? null,
          booleans?.is_telecaller ?? null,
          booleans?.is_field_agent ?? null,
          agentTypeChanging,
          newAgentType,
        ],
      );
      updatedUser = rows[0];

      // Audit trail for the changes that actually matter operationally --
      // capability/designation, branch/team reassignment, and deactivation.
      // Written inside this same transaction so it commits or rolls back
      // atomically with the change it describes.
      const changedFields: Record<string, unknown> = {};
      if (body.designation !== undefined && body.designation !== existing.designation) {
        changedFields.designation = { from: existing.designation, to: body.designation };
      }
      if (body.branch_id !== undefined && body.branch_id !== existing.branch_id) {
        changedFields.branch_id = { from: existing.branch_id, to: body.branch_id };
      }
      if (body.team_id !== undefined && body.team_id !== existing.team_id) {
        changedFields.team_id = { from: existing.team_id, to: body.team_id };
      }
      if (body.is_active !== undefined && body.is_active !== existing.is_active) {
        changedFields.is_active = { from: existing.is_active, to: body.is_active };
      }
      if (Object.keys(changedFields).length > 0) {
        await recordAuditLog(client, {
          agencyId: req.user!.agency_id,
          actorId: req.user!.id,
          action: "employee.update",
          entityType: "user",
          entityId: req.params.id,
          details: changedFields,
        });
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Deactivation takes effect immediately: kill sessions.
    if (body.is_active === false) {
      await pool.query(
        "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'deactivated' WHERE user_id = $1 AND revoked_at IS NULL",
        [req.params.id],
      );
    }
    res.json({ employee: { ...publicUser(updatedUser), is_active: updatedUser.is_active, managed_branch_id: managedBranchIdToReturn } });
  }),
);

const resetPasswordSchema = z.object({ new_password: z.string().min(8) });

router.post(
  "/:id/reset-password",
  requirePermission("employees.update"),
  asyncHandler(async (req, res) => {
    const body = resetPasswordSchema.parse(req.body);
    const { rows } = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1 AND agency_id = $2",
      [req.params.id, req.user!.agency_id],
    );
    if (!rows[0]) throw new HttpError(404, "Employee not found");
    if (rows[0].is_agency_admin) {
      throw new HttpError(403, "The Agency Admin password is reset via OTP or the seed script");
    }
    const passwordHash = await hashPassword(body.new_password);
    await pool.query(
      `UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL
       WHERE id = $1`,
      [req.params.id, passwordHash],
    );
    // A5/O4: this reset exists mainly for A4's mobile-forgot-password flow —
    // the requester's live mobile session (if any) must not be destroyed by
    // it. Web sessions (device_id IS NULL) are revoked; mobile sessions
    // (device_id IS NOT NULL) are left alone. Contrast with the blanket
    // revoke above on deactivation, which is deliberately unscoped.
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'admin_reset'
       WHERE user_id = $1 AND revoked_at IS NULL AND device_id IS NULL`,
      [req.params.id],
    );
    await recordAuditLog(pool, {
      agencyId: req.user!.agency_id,
      actorId: req.user!.id,
      action: "employee.reset_password",
      entityType: "user",
      entityId: req.params.id,
    });
    await notifyCredentials(rows[0].phone, body.new_password, true);
    res.json({ ok: true });
  }),
);

// Assign branches to a telecaller (replace-set, used for multi-branch assignment)
router.put(
  "/:id/branches",
  requirePermission("employees.update"),
  asyncHandler(async (req, res) => {
    const body = z.object({ branch_ids: z.array(z.string().uuid()) }).parse(req.body);

    // Fetch user and verify they're a telecaller
    const { rows: userRows } = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1 AND agency_id = $2",
      [req.params.id, req.user!.agency_id],
    );
    if (!userRows[0]) throw new HttpError(404, "Employee not found");
    const isTelecallerType =
      userRows[0].designation === "telecaller" || userRows[0].agent_type === "telecaller";
    if (!isTelecallerType) {
      throw new HttpError(
        400,
        "Only telecallers (or branch managers with telecaller-type work) can have multiple branches assigned",
      );
    }

    // Validate all branches belong to this agency
    if (body.branch_ids.length > 0) {
      const { rows: branches } = await pool.query(
        "SELECT id FROM branches WHERE id = ANY($1::uuid[]) AND agency_id = $2",
        [body.branch_ids, req.user!.agency_id],
      );
      if (branches.length !== body.branch_ids.length) {
        throw new HttpError(400, "One or more branches not found in this agency");
      }
      // Plain telecallers need a branch_manager in every branch they cover
      // (same precondition as a single-branch field_agent); a branch_manager
      // doing telecaller-type work themselves is exempt -- they don't need
      // to be managed by another branch_manager to cover extra branches.
      if (userRows[0].designation === "telecaller") {
        await assertBranchesHaveManager(req.user!.agency_id, body.branch_ids);
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      
      const { rows: existingRows } = await client.query<{ branch_id: string }>(
        "SELECT branch_id FROM telecaller_branches WHERE user_id = $1", [req.params.id]
      );
      const existingBranchIds = existingRows.map(r => r.branch_id);
      const removedBranches = existingBranchIds.filter(id => !body.branch_ids.includes(id));

      if (removedBranches.length > 0) {
        await client.query(
          `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason, slot)
           SELECT id, assigned_agent_id, NULL, $2, 'Agent removed from branch', 'primary'
           FROM customers WHERE assigned_agent_id = $1 AND branch_id = ANY($3)`,
          [req.params.id, req.user!.id, removedBranches]
        );
        await client.query(
          "UPDATE customers SET assigned_agent_id = NULL WHERE assigned_agent_id = $1 AND branch_id = ANY($2)",
          [req.params.id, removedBranches]
        );
      }

      // Replace telecaller_branches entries
      await client.query("DELETE FROM telecaller_branches WHERE user_id = $1", [req.params.id]);
      if (body.branch_ids.length > 0) {
        await client.query(
          "INSERT INTO telecaller_branches (user_id, branch_id) SELECT $1, unnest($2::uuid[])",
          [req.params.id, body.branch_ids],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  }),
);

// Assign teams to telecaller-type work (replace-set, mirrors PUT /:id/branches
// above). Covers plain telecallers and branch_manager rows with
// agent_type = 'telecaller' -- their work is remote calling, not tied to one
// team, same reasoning as multi-branch.
router.put(
  "/:id/teams",
  requirePermission("employees.update"),
  asyncHandler(async (req, res) => {
    const body = z.object({ team_ids: z.array(z.string().uuid()) }).parse(req.body);

    const { rows: userRows } = await pool.query<UserRow>(
      "SELECT * FROM users WHERE id = $1 AND agency_id = $2",
      [req.params.id, req.user!.agency_id],
    );
    if (!userRows[0]) throw new HttpError(404, "Employee not found");
    const isTelecallerType =
      userRows[0].designation === "telecaller" || userRows[0].agent_type === "telecaller";
    if (!isTelecallerType) {
      throw new HttpError(
        400,
        "Only telecallers (or branch managers/team leaders with telecaller-type work) can have multiple teams assigned",
      );
    }

    // Validate all teams belong to this agency
    if (body.team_ids.length > 0) {
      const { rows: teams } = await pool.query(
        `SELECT t.id FROM teams t JOIN branches b ON b.id = t.branch_id
          WHERE t.id = ANY($1::uuid[]) AND b.agency_id = $2`,
        [body.team_ids, req.user!.agency_id],
      );
      if (teams.length !== body.team_ids.length) {
        throw new HttpError(400, "One or more teams not found in this agency");
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: existingRows } = await client.query<{ team_id: string }>(
        "SELECT team_id FROM telecaller_teams WHERE user_id = $1", [req.params.id]
      );
      const existingTeamIds = existingRows.map(r => r.team_id);
      const removedTeams = existingTeamIds.filter(id => !body.team_ids.includes(id));

      if (removedTeams.length > 0) {
        await client.query(
          `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason, slot)
           SELECT id, assigned_agent_id, NULL, $2, 'Agent removed from team', 'primary'
           FROM customers WHERE assigned_agent_id = $1 AND assigned_team_id = ANY($3)`,
          [req.params.id, req.user!.id, removedTeams]
        );
        await client.query(
          "UPDATE customers SET assigned_agent_id = NULL WHERE assigned_agent_id = $1 AND assigned_team_id = ANY($2)",
          [req.params.id, removedTeams]
        );
      }

      // Replace telecaller_teams entries
      await client.query("DELETE FROM telecaller_teams WHERE user_id = $1", [req.params.id]);
      if (body.team_ids.length > 0) {
        await client.query(
          "INSERT INTO telecaller_teams (user_id, team_id) SELECT $1, unnest($2::uuid[])",
          [req.params.id, body.team_ids],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  }),
);

export default router;
