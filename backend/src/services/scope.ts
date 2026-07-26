import { pool } from "../config/db";

/**
 * Visibility scope (brief Section 3): Agency Admin / Ops Manager see the
 * whole agency; a Branch Manager sees their whole branch (every team in it,
 * directly -- no team_leader intermediary since Phase 2). Returns SQL
 * filter parts to AND onto a query already filtered by agency_id --
 * callers substitute the `$SCOPE` placeholder for the next positional
 * parameter.
 *
 * Phase 12: telecaller/field_agent now also hold tracking.view (self only —
 * their mobile dashboards need their own attendance/GPS/route), so instead of
 * failing shut for "neither admin/ops nor branch_manager" this falls back to
 * a self-only clause (`u.id = $SCOPE`) rather than a 403.
 *
 * branch_manager: sees everyone whose scalar branch_id matches the branch
 * they manage (branches.branch_manager_id), PLUS any telecaller assigned to
 * that branch via the telecaller_branches junction table even if that
 * telecaller's own scalar branch_id points elsewhere -- this is what keeps a
 * multi-branch telecaller visible to every branch manager who has them
 * assigned, not just the one matching their scalar branch_id.
 */
export async function scopeFilter(user: {
  id: string;
  is_agency_admin: boolean;
  is_operations_manager: boolean;
  team_id: string | null;
  designation?: string;
}): Promise<{ clause: string; param: string | string[] | null }> {
  if (user.is_agency_admin || user.is_operations_manager) {
    return { clause: "", param: null };
  }
  if (user.designation === "branch_manager") {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM branches WHERE branch_manager_id = $1",
      [user.id],
    );
    const branchId = rows[0]?.id;
    if (!branchId) {
      // Not yet assigned to a branch -> sees nothing.
      return { clause: "AND u.branch_id = $SCOPE", param: "00000000-0000-0000-0000-000000000000" };
    }
    return {
      clause:
        "AND (u.branch_id = $SCOPE OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = u.id AND tb.branch_id = $SCOPE))",
      param: branchId,
    };
  }
  return { clause: "AND u.id = $SCOPE", param: user.id };
}

const NO_BRANCH_SENTINEL = "00000000-0000-0000-0000-000000000000";

/**
 * Same branch-manager clamp as scopeFilter(), but returns the raw branch id
 * (+ name) instead of a `users`-shaped SQL clause -- for routes that join
 * through customers/teams (customers.branch_id, teams.branch_id via
 * assigned_team_id, or the assigned agent's own branch/team) rather than
 * `users u` directly. Only call this from inside a branch already gated by
 * a broad permission (customers.allocate, employees.view, etc.) -- it's not
 * a substitute for the permission check, just the missing middle tier
 * between "sees their own record only" and "sees the whole agency."
 *
 * The name is included because `customers.branch_id` is opt-in per company
 * (see 1787400000000_field-config-customer-branch.sql, disabled by
 * default) -- most companies never populate it, so clamping on the id alone
 * would make a branch_manager see ZERO unallocated customers for any
 * company that hasn't opted in. Callers should match EITHER the structured
 * id OR the freetext custom_fields.branch/.Branch text against the name,
 * the same "resolved actual branch" pattern already used for the branch
 * filter/column elsewhere (customers.ts, allocations.ts, worklist.ts).
 *
 * null = no restriction (agency_admin/operations_manager). Anything else
 * (branch_manager, or any unexpected caller) gets a real branch to clamp
 * to, or the zero-UUID/empty-name sentinel scopeFilter() uses when they
 * don't manage any branch yet -- fails closed, never opens up to "see
 * everything."
 */
export async function resolveBranchClamp(user: {
  id: string;
  is_agency_admin: boolean;
  is_operations_manager: boolean;
}): Promise<{ branchId: string; branchName: string } | null> {
  if (user.is_agency_admin || user.is_operations_manager) return null;
  const { rows } = await pool.query<{ id: string; name: string }>(
    "SELECT id, name FROM branches WHERE branch_manager_id = $1",
    [user.id],
  );
  return rows[0]
    ? { branchId: rows[0].id, branchName: rows[0].name }
    : { branchId: NO_BRANCH_SENTINEL, branchName: NO_BRANCH_SENTINEL };
}

export type BranchClamp = { branchId: string; branchName: string } | null;

/**
 * AND-able clause confining a customer row (alias defaults to `c`) to a
 * resolveBranchClamp() result -- structured branch_id when set, else a
 * freetext custom_fields.branch/.Branch match against the branch's name
 * (customers.branch_id is opt-in per company, most never populate it).
 * Returns "" for a null clamp (no restriction). Pushes 2 params when active.
 */
export function customerBranchClamp(clamp: BranchClamp, params: unknown[], alias = "c"): string {
  if (!clamp) return "";
  params.push(clamp.branchId, clamp.branchName);
  const idN = params.length - 1;
  const nameN = params.length;
  return ` AND (${alias}.branch_id::text = $${idN} OR (${alias}.branch_id IS NULL AND (${alias}.custom_fields->>'branch' ILIKE $${nameN} OR ${alias}.custom_fields->>'Branch' ILIKE $${nameN})))`;
}

/**
 * AND-able clause confining a `users` row (an agent, alias required -- the
 * caller's query decides it) to a resolveBranchClamp() result, matching a
 * multi-branch telecaller via telecaller_branches the same way scopeFilter()
 * does. Returns "" for a null clamp. Pushes 1 param when active.
 */
export function agentBranchClamp(clamp: BranchClamp, params: unknown[], alias: string): string {
  if (!clamp) return "";
  params.push(clamp.branchId);
  const n = params.length;
  return ` AND (${alias}.branch_id = $${n} OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = ${alias}.id AND tb.branch_id = $${n}))`;
}

/**
 * AND-able write-path scope clamp for customer-linked records (call logs,
 * payments, field visits, attachments, reminders). Before this existed,
 * those five routes checked only `co.agency_id`, so any authenticated user
 * holding the relevant permission (calls.log, payments.record, ...) could
 * write against ANY customer in the agency -- an agent in Branch A could
 * record a collection against Branch B's customer and it would count
 * toward their own numbers.
 *
 * A write is allowed when the customer is assigned to the caller directly
 * (as primary or field agent) -- the common case for every agent -- OR,
 * for a branch_manager, when the customer's assigned agent (primary or
 * field) falls within the branch they manage, mirroring the same "team"
 * visibility rule the worklist already uses for reads. agency_admin /
 * operations_manager get resolveBranchClamp()'s null and are unrestricted.
 *
 * Returns "" for admin/ops (no restriction). Pushes params as needed.
 */
export async function customerWriteScopeClamp(
  user: {
    id: string;
    is_agency_admin: boolean;
    is_operations_manager: boolean;
  },
  params: unknown[],
  customerAlias = "c",
): Promise<string> {
  const clamp = await resolveBranchClamp(user);
  if (!clamp) return "";
  params.push(user.id);
  const selfN = params.length;
  const agentMatch = agentBranchClamp(clamp, params, "wsc_agent").replace(/^ AND /, "");
  const fieldAgentMatch = agentBranchClamp(clamp, params, "wsc_field_agent").replace(/^ AND /, "");
  return ` AND (
    ${customerAlias}.assigned_agent_id = $${selfN} OR ${customerAlias}.assigned_field_agent_id = $${selfN}
    OR EXISTS (SELECT 1 FROM users wsc_agent WHERE wsc_agent.id = ${customerAlias}.assigned_agent_id AND ${agentMatch})
    OR EXISTS (SELECT 1 FROM users wsc_field_agent WHERE wsc_field_agent.id = ${customerAlias}.assigned_field_agent_id AND ${fieldAgentMatch})
  )`;
}
