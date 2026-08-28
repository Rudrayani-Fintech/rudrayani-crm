import { pool } from "../config/db";
import { HttpError } from "../middleware/error-handler";
import type { UserRow } from "../types/user";
import { istToday } from "../utils/ist";

/**
 * Performance report engine (Phase 5). The allocated book for month M is
 * customer_month_snapshots(M); metric classification per account:
 *
 *  - once month M+1's allocation file exists (basis "transition"):
 *      resolution    = didn't flow forward (next sort <= current sort);
 *                      closed accounts count as resolved
 *      rollback      = moved strictly back but not to the current bucket
 *      normalization = landed in the company's is_current bucket
 *  - before that (basis "payments" — live MTD):
 *      resolution    = paid at least one EMI this month (no EMI -> any payment)
 *      rollback      = paid >= 1 EMI but less than the full arrears
 *      normalization = paid the full arrears (due_amount)
 *  - recovery is always payments-based: money collected on NPA-bucket
 *    accounts; its allocated base is the NPA slice only.
 *
 * Attribution: the allocated book belongs to the snapshot's agent (stable for
 * the month); collected money belongs to payments.collected_by_user_id.
 */

export const REPORT_METRICS = [
  "resolution",
  "rollback",
  "normalization",
  "recovery",
  "collection",
] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

export interface ReportFilters {
  month: string; // 'YYYY-MM-01'
  company_id?: string;
  branch_id?: string;
  team_id?: string;
  agent_id?: string;
  product?: string;
  bucket?: string;
  /** Narrows to the customer's CURRENT status (not the status at the time of the snapshot). */
  status?: "active" | "closed" | "recalled";
}

export interface ResolvedScope {
  clampedTo: "agency" | "branch" | "self";
  filters: ReportFilters;
}

/**
 * Server-side scope clamp: admin/ops roam the agency; a branch_manager is
 * pinned to their branch (every team in it, no team_leader intermediary
 * since Phase 2); everyone else (self-scoped access) is pinned to
 * themselves.
 */
export async function resolveReportScope(
  user: UserRow,
  requested: ReportFilters,
  hasFullView: boolean,
): Promise<ResolvedScope> {
  if (!hasFullView) {
    if (requested.agent_id && requested.agent_id !== user.id) {
      throw new HttpError(403, "You can only view your own performance");
    }
    return {
      clampedTo: "self",
      filters: { ...requested, agent_id: user.id, branch_id: undefined, team_id: undefined },
    };
  }
  if (user.is_agency_admin || user.is_operations_manager) {
    return { clampedTo: "agency", filters: requested };
  }
  if (user.designation === "branch_manager") {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM branches WHERE branch_manager_id = $1",
      [user.id],
    );
    const branchId = rows[0]?.id;
    if (requested.branch_id && requested.branch_id !== branchId) {
      throw new HttpError(403, "You do not manage this branch");
    }
    // Previously this unconditionally set team_id: undefined below,
    // silently discarding whatever team the manager had selected -- the
    // dashboard just re-showed branch-wide numbers with no indication the
    // filter did nothing. Validate instead of dropping: a team inside the
    // branch they manage is honoured, one outside it is rejected, the same
    // way an out-of-branch branch_id is rejected just above.
    if (requested.team_id) {
      const teamRes = await pool.query<{ branch_id: string }>(
        "SELECT branch_id FROM teams WHERE id = $1",
        [requested.team_id],
      );
      if (!teamRes.rows[0] || teamRes.rows[0].branch_id !== branchId) {
        throw new HttpError(403, "That team is not in a branch you manage");
      }
    }
    // Not yet assigned to a branch (optional-at-creation) -> sees nothing,
    // same sentinel-UUID pattern used elsewhere for "no scope yet" rather
    // than a 500 or an accidental agency-wide fallthrough.
    return {
      clampedTo: "branch",
      filters: {
        ...requested,
        branch_id: branchId ?? "00000000-0000-0000-0000-000000000000",
      },
    };
  }
  // reports.view holders that fit none of the above shouldn't exist, but fail shut.
  return {
    clampedTo: "self",
    filters: { ...requested, agent_id: user.id, branch_id: undefined, team_id: undefined },
  };
}

/**
 * Branch clamp for the report engine (mirrors scope.ts's
 * customerBranchClamp()/agentBranchClamp(), but as a single OR'd clause for
 * queries that need all three signals at once). `customers.assigned_team_id`
 * is only ever populated as the assigned agent's own team_id at allocation
 * time (allocations.ts) -- a branch whose agents were never grouped into a
 * team leaves assigned_team_id NULL on every row, so a bare `tm.branch_id =
 * $N` (tm joined off assigned_team_id) matches zero rows and every
 * SUM/COUNT aggregate silently collapses to 0. This ORs together every
 * signal that can place a row in the branch, so it only ever WIDENS which
 * rows match versus the old tm-only clamp, never narrows:
 *  (a) the customer's own structured branch_id, or (when that's NULL) the
 *      freetext custom_fields.branch/.Branch matched by name (branch_id is
 *      opt-in per company -- most never populate it, same fallback
 *      customerBranchClamp() already uses elsewhere);
 *  (b) the team's branch_id, when a team alias is joined (still correct
 *      when a team IS set, just not sufficient alone);
 *  (c) for each given agent column (e.g. s.assigned_agent_id,
 *      c.assigned_field_agent_id), that agent's own branch_id or a
 *      telecaller_branches assignment to this branch (agentBranchClamp()'s
 *      pattern) -- catches a team-less agent whose customer has no branch_id
 *      of its own either.
 * Pushes exactly one param (branchId), referenced by every OR'd arm.
 */
function reportBranchClause(
  branchId: string,
  params: unknown[],
  customerAlias: string,
  teamAlias: string | null,
  agentCols: string[],
): string {
  params.push(branchId);
  const n = params.length;
  // Every occurrence of $n below is cast ::uuid explicitly -- Postgres infers
  // one type per placeholder number across the WHOLE query, so leaving even
  // one occurrence uncast (or cast to ::text) while the rest compare against
  // uuid columns raises "operator does not exist: uuid = text" once both
  // shapes appear together.
  const branchName = `(SELECT name FROM branches WHERE id = $${n}::uuid)`;
  const parts: string[] = [
    `(${customerAlias}.branch_id = $${n}::uuid OR (${customerAlias}.branch_id IS NULL AND (${customerAlias}.custom_fields->>'branch' ILIKE ${branchName} OR ${customerAlias}.custom_fields->>'Branch' ILIKE ${branchName})))`,
  ];
  if (teamAlias) {
    parts.push(`${teamAlias}.branch_id = $${n}::uuid`);
  }
  for (const col of agentCols) {
    parts.push(
      `EXISTS (SELECT 1 FROM users u WHERE u.id = ${col} AND (u.branch_id = $${n}::uuid OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = u.id AND tb.branch_id = $${n}::uuid)))`,
    );
  }
  return `(${parts.join(" OR ")})`;
}

export interface MonthDays {
  in_month: number;
  elapsed: number;
  left: number;
}

/** Day arithmetic in IST — a month that's over is fully elapsed, a future one not started. */
export function monthDays(month: string, now = new Date()): MonthDays {
  const [y, m] = month.split("-").map(Number);
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // istToday() (Intl-backed, en-CA -> 'YYYY-MM-DD') replaces a fragile
  // locale-string round-trip through `new Date(...)`, whose parsing is not
  // guaranteed stable across Node/ICU builds.
  const [curY, curM, curD] = istToday(now).split("-").map(Number);
  if (y < curY || (y === curY && m < curM)) return { in_month: inMonth, elapsed: inMonth, left: 0 };
  if (y > curY || (y === curY && m > curM)) return { in_month: inMonth, elapsed: 0, left: inMonth };
  return { in_month: inMonth, elapsed: curD, left: inMonth - curD };
}

/** Is `month` ('YYYY-MM' or 'YYYY-MM-01') the current calendar month in IST? */
function isCurrentMonth(month: string, now = new Date()): boolean {
  const [y, m] = month.split("-").map(Number);
  const [curY, curM] = istToday(now).split("-").map(Number);
  return y === curY && m === curM;
}

/**
 * `customer_month_snapshots.assigned_team_id` is only ever populated as the
 * assigned agent's own team_id AT ALLOCATION TIME (allocations.ts) -- it's
 * NULL for any customer whose agent wasn't grouped into a team when
 * allocated, and stays stale forever after that agent later moves teams. A
 * bare `s.assigned_team_id = $N` therefore silently collapses to zero rows
 * for both cases -- selecting a team on the dashboard either showed nothing
 * or, worse, kept showing the PREVIOUS team's numbers for an agent who
 * moved. This ORs in the assigned agent's CURRENT team membership (scalar
 * team_id, or the telecaller_teams junction for multi-team members) so a
 * team filter reflects reality instead of an allocation-time snapshot --
 * mirrors reportBranchClause()'s own "only ever widen, never narrow" fix
 * for the identical problem on branch_id.
 */
function reportTeamClause(
  teamId: string,
  params: unknown[],
  customerAlias: string,
  agentCols: string[],
): string {
  params.push(teamId);
  const n = params.length;
  const parts = [`${customerAlias}.assigned_team_id = $${n}`];
  for (const col of agentCols) {
    parts.push(
      `EXISTS (SELECT 1 FROM users rtc_agent WHERE rtc_agent.id = ${col}
        AND (rtc_agent.team_id = $${n}
             OR EXISTS (SELECT 1 FROM telecaller_teams tt WHERE tt.user_id = rtc_agent.id AND tt.team_id = $${n})))`,
    );
  }
  return `(${parts.join(" OR ")})`;
}

/** WHERE fragments for the snapshot base under the resolved filters. */
function baseConditions(filters: ReportFilters, params: unknown[]): string[] {
  const conditions: string[] = [];
  if (filters.company_id) {
    params.push(filters.company_id);
    conditions.push(`s.company_id = $${params.length}`);
  }
  if (filters.branch_id) {
    conditions.push(reportBranchClause(filters.branch_id, params, "c", "tm", ["s.assigned_agent_id"]));
  }
  if (filters.team_id) {
    conditions.push(reportTeamClause(filters.team_id, params, "s", ["s.assigned_agent_id"]));
  }
  if (filters.agent_id) {
    params.push(filters.agent_id);
    conditions.push(`s.assigned_agent_id = $${params.length}`);
  }
  if (filters.product) {
    // The filter value is the canonical label; snapshots store the raw label.
    params.push(filters.product);
    conditions.push(
      `(lower(s.product) = lower($${params.length}) OR EXISTS (
          SELECT 1 FROM products pr
           WHERE pr.company_id = s.company_id
             AND lower(pr.raw_label) = lower(s.product)
             AND lower(pr.canonical_label) = lower($${params.length})))`,
    );
  }
  if (filters.bucket) {
    params.push(filters.bucket);
    conditions.push(`lower(s.bucket) = lower($${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`c.status = $${params.length}`);
  }
  return conditions;
}

/**
 * WHERE fragments against the LIVE `customers` table — same shape as
 * baseConditions() but for the current month, which has no frozen snapshot
 * to read (Phase 8 computed-default target).
 */
function liveConditions(filters: ReportFilters, params: unknown[]): string[] {
  const conditions: string[] = [];
  if (filters.company_id) {
    params.push(filters.company_id);
    conditions.push(`c.company_id = $${params.length}`);
  }
  if (filters.branch_id) {
    conditions.push(
      reportBranchClause(filters.branch_id, params, "c", "tm", [
        "c.assigned_agent_id",
        "c.assigned_field_agent_id",
      ]),
    );
  }
  if (filters.team_id) {
    // Previously a bare `c.assigned_team_id = $N` -- same collapse-to-zero
    // bug as baseConditions() had (1B.4) for any team-less agent, just on
    // the live-customers path instead of the snapshot path.
    conditions.push(
      reportTeamClause(filters.team_id, params, "c", [
        "c.assigned_agent_id",
        "c.assigned_field_agent_id",
      ]),
    );
  }
  if (filters.agent_id) {
    params.push(filters.agent_id);
    conditions.push(`c.assigned_agent_id = $${params.length}`);
  }
  if (filters.product) {
    params.push(filters.product);
    conditions.push(
      `(lower(c.product) = lower($${params.length}) OR EXISTS (
          SELECT 1 FROM products pr
           WHERE pr.company_id = c.company_id
             AND lower(pr.raw_label) = lower(c.product)
             AND lower(pr.canonical_label) = lower($${params.length})))`,
    );
  }
  if (filters.bucket) {
    params.push(filters.bucket);
    conditions.push(`lower(c.bucket) = lower($${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`c.status = $${params.length}`);
  }
  return conditions;
}

/**
 * Book totals (SUM(emi), SUM(pos), COUNT) under the resolved scope/dimension
 * filters — current month reads the live `customers` table (up to date);
 * past months read the frozen `customer_month_snapshots` row for that month
 * (what the book looked like then). Backs the Phase 8 computed-default
 * collection target and the pos_total secondary stat.
 */
export interface BookTotals {
  count: number;
  emi_total: number;
  pos_total: number;
}

export async function bookTotals(agencyId: string, filters: ReportFilters): Promise<BookTotals> {
  if (isCurrentMonth(filters.month.slice(0, 7))) {
    const params: unknown[] = [agencyId];
    const conditions = liveConditions(filters, params);
    const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(c.emi), 0)::float AS emi_total,
              COALESCE(SUM(c.pos), 0)::float AS pos_total
         FROM customers c
         JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
         LEFT JOIN teams tm ON tm.id = c.assigned_team_id
        WHERE true ${where}`,
      params,
    );
    return { count: rows[0].n, emi_total: rows[0].emi_total, pos_total: rows[0].pos_total };
  }
  const params: unknown[] = [agencyId, filters.month];
  const conditions = baseConditions(filters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(s.emi), 0)::float AS emi_total,
            COALESCE(SUM(s.pos), 0)::float AS pos_total
       FROM customer_month_snapshots s
       JOIN companies co ON co.id = s.company_id AND co.agency_id = $1
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN teams tm ON tm.id = s.assigned_team_id
      WHERE s.month = $2::date ${where}`,
    params,
  );
  return { count: rows[0].n, emi_total: rows[0].emi_total, pos_total: rows[0].pos_total };
}

export interface ScopeBookTotal {
  scope_id: string | null;
  count: number;
  emi_total: number;
  pos_total: number;
}

const SCOPE_GROUP_EXPR: Record<"agency" | "branch" | "team" | "agent", { live: string; snap: string }> = {
  agency: { live: "NULL::uuid", snap: "NULL::uuid" },
  // Same tm-then-customer-then-agent fallback as reportBranchClause()/
  // classifiedCtes() -- a team-less agent's book would otherwise group under
  // scope_id = NULL and vanish from the Targets page's per-branch column.
  // The snapshot side prefers s.branch_id (captured at import time) first --
  // falling back to CURRENT customer/agent branch only for older snapshot
  // rows written before that column existed.
  branch: {
    live: "COALESCE(tm.branch_id, c.branch_id, u.branch_id)",
    snap: "COALESCE(s.branch_id, tm.branch_id, c.branch_id, u.branch_id)",
  },
  team: { live: "c.assigned_team_id", snap: "s.assigned_team_id" },
  agent: { live: "c.assigned_agent_id", snap: "s.assigned_agent_id" },
};

/**
 * Same book totals as bookTotals(), but grouped per entity at one scope
 * level instead of narrowed to a single one -- backs the Targets page's
 * "what would the computed default be" column so admins can see the book
 * size while setting manual targets, without an N+1 fetch per row.
 */
export async function bookTotalsByScope(
  agencyId: string,
  month: string, // 'YYYY-MM-01'
  scopeType: "agency" | "branch" | "team" | "agent",
): Promise<ScopeBookTotal[]> {
  const g = SCOPE_GROUP_EXPR[scopeType];
  if (isCurrentMonth(month.slice(0, 7))) {
    const { rows } = await pool.query(
      `SELECT ${g.live} AS scope_id, COUNT(*)::int AS count,
              COALESCE(SUM(c.emi), 0)::float AS emi_total,
              COALESCE(SUM(c.pos), 0)::float AS pos_total
         FROM customers c
         JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
         LEFT JOIN teams tm ON tm.id = c.assigned_team_id
         LEFT JOIN users u ON u.id = c.assigned_agent_id
        GROUP BY ${g.live}`,
      [agencyId],
    );
    return rows as ScopeBookTotal[];
  }
  const { rows } = await pool.query(
    `SELECT ${g.snap} AS scope_id, COUNT(*)::int AS count,
            COALESCE(SUM(s.emi), 0)::float AS emi_total,
            COALESCE(SUM(s.pos), 0)::float AS pos_total
       FROM customer_month_snapshots s
       JOIN companies co ON co.id = s.company_id AND co.agency_id = $1
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN teams tm ON tm.id = s.assigned_team_id
       LEFT JOIN users u ON u.id = s.assigned_agent_id
      WHERE s.month = $2::date
      GROUP BY ${g.snap}`,
    [agencyId, month],
  );
  return rows as ScopeBookTotal[];
}

/** Is there a next-month allocation file to compare against (transition basis)? */
async function hasNextMonthSnapshot(
  agencyId: string,
  filters: ReportFilters,
): Promise<boolean> {
  const params: unknown[] = [agencyId, filters.month];
  const companyClause = filters.company_id
    ? (params.push(filters.company_id), `AND s.company_id = $${params.length}`)
    : "";
  const { rows } = await pool.query(
    `SELECT 1 FROM customer_month_snapshots s
       JOIN companies co ON co.id = s.company_id
      WHERE co.agency_id = $1
        AND s.month = ($2::date + interval '1 month')::date ${companyClause}
      LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

interface ClassifiedAggregates {
  allocated_count: number;
  allocated_amount: number;
  recovery_allocated_count: number;
  recovery_allocated_amount: number;
  collected_amount: number;
  collected_count: number;
  resolution_amount: number;
  resolution_count: number;
  rollback_amount: number;
  rollback_count: number;
  normalization_amount: number;
  normalization_count: number;
  recovery_amount: number;
  recovery_count: number;
  trail_count: number;
}

/** The classification CTE chain shared by the dashboard totals and the per-agent breakdown. */
function classifiedCtes(conditions: string[]): string {
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  return `
    base AS (
      SELECT s.customer_id, s.due_amount, s.pos, s.emi, s.assigned_agent_id, s.assigned_team_id,
             s.product, s.company_id, s.bucket,
             bm.sort_order AS cur_sort, COALESCE(bm.category, 'normal') AS cur_cat,
             c.status,
             co.name AS company_name, tm.name AS team_name,
             -- s.branch_id is captured at snapshot time (import-service.ts)
             -- and is the correct historical answer; the rest of the chain
             -- is the same tm-then-customer-then-agent fallback as
             -- reportBranchClause(), kept only for snapshot rows written
             -- before that column existed -- a team-less agent's customer
             -- would otherwise group under branch_id = NULL here and get
             -- dropped by dimensionBreakdown()'s "WHERE ... IS NOT NULL"
             -- filter even after the WHERE clause above widened to include it.
             COALESCE(s.branch_id, tm.branch_id, c.branch_id, au.branch_id) AS branch_id,
             COALESCE(br.name, cbr.name, aubr.name,
                      NULLIF(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')), '')) AS branch_name,
             au.full_name AS agent_name,
             COALESCE(pr.canonical_label, s.product) AS canonical_product
        FROM customer_month_snapshots s
        JOIN companies co ON co.id = s.company_id AND co.agency_id = $1
        JOIN customers c ON c.id = s.customer_id
        LEFT JOIN buckets bm ON bm.company_id = s.company_id AND lower(bm.label) = lower(s.bucket)
        LEFT JOIN teams tm ON tm.id = s.assigned_team_id
        LEFT JOIN branches br ON br.id = tm.branch_id
        LEFT JOIN branches cbr ON cbr.id = c.branch_id
        LEFT JOIN users au ON au.id = s.assigned_agent_id
        LEFT JOIN branches aubr ON aubr.id = au.branch_id
        LEFT JOIN products pr ON pr.company_id = s.company_id AND lower(pr.raw_label) = lower(s.product)
       WHERE s.month = $2::date ${where}
    ),
    pays AS (
      SELECT b.customer_id, SUM(p.amount) AS paid
        FROM payments p JOIN base b ON b.customer_id = p.customer_id
       WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND p.paid_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
       GROUP BY 1
    ),
    nxt AS (
      SELECT s2.customer_id, b2.sort_order AS nxt_sort,
             COALESCE(b2.is_current, false) AS nxt_is_current
        FROM customer_month_snapshots s2
        JOIN base b ON b.customer_id = s2.customer_id
        LEFT JOIN buckets b2 ON b2.company_id = s2.company_id AND lower(b2.label) = lower(s2.bucket)
       WHERE s2.month = ($2::date + interval '1 month')::date
    ),
    trail AS (
      SELECT b.customer_id
        FROM base b
       WHERE EXISTS (SELECT 1 FROM call_logs cl WHERE cl.customer_id = b.customer_id
                        AND cl.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
                        AND cl.created_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata'))
          OR EXISTS (SELECT 1 FROM field_visits fv WHERE fv.customer_id = b.customer_id
                        AND fv.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
                        AND fv.created_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata'))
    ),
    class AS (
      SELECT b.*, COALESCE(p.paid, 0) AS paid,
             (t.customer_id IS NOT NULL) AS has_trail,
        CASE WHEN $3::boolean THEN
          CASE WHEN n.customer_id IS NULL AND b.status = 'closed' THEN true
               WHEN n.customer_id IS NULL THEN NULL          -- dropped from next file: excluded
               ELSE n.nxt_sort IS NOT NULL AND b.cur_sort IS NOT NULL AND n.nxt_sort <= b.cur_sort
          END
        ELSE
          COALESCE(p.paid, 0) > 0
          AND (b.emi IS NULL OR b.emi <= 0 OR COALESCE(p.paid, 0) >= b.emi)
        END AS is_resolved,
        CASE WHEN $3::boolean THEN COALESCE(n.nxt_is_current, false)
        ELSE b.due_amount > 0 AND COALESCE(p.paid, 0) >= b.due_amount
        END AS is_normalized,
        CASE WHEN $3::boolean THEN
          n.nxt_sort IS NOT NULL AND b.cur_sort IS NOT NULL
          AND n.nxt_sort < b.cur_sort AND NOT n.nxt_is_current
        ELSE
          b.emi > 0 AND COALESCE(p.paid, 0) >= b.emi
          AND (b.due_amount IS NULL OR COALESCE(p.paid, 0) < b.due_amount)
        END AS is_rolled_back
      FROM base b
      LEFT JOIN pays p ON p.customer_id = b.customer_id
      LEFT JOIN nxt n ON n.customer_id = b.customer_id
      LEFT JOIN trail t ON t.customer_id = b.customer_id
    )`;
}

// Owner feedback round, Phase 2: portfolio-value aggregates (how much book do
// we have) read SUM(pos) -- principal outstanding -- instead of due_amount;
// due_amount keeps its narrower "current arrears" meaning, still used by the
// is_resolved/is_normalized/is_rolled_back classification CASE expressions
// above (unchanged).
const AGGREGATE_SELECT = `
  COUNT(*)::int                                                    AS allocated_count,
  COALESCE(SUM(pos), 0)::float                                     AS allocated_amount,
  COUNT(*) FILTER (WHERE cur_cat = 'npa')::int                     AS recovery_allocated_count,
  COALESCE(SUM(pos) FILTER (WHERE cur_cat = 'npa'), 0)::float      AS recovery_allocated_amount,
  COALESCE(SUM(paid), 0)::float                                    AS collected_amount,
  COUNT(*) FILTER (WHERE paid > 0)::int                            AS collected_count,
  COALESCE(SUM(pos) FILTER (WHERE is_resolved), 0)::float          AS resolution_amount,
  COUNT(*) FILTER (WHERE is_resolved)::int                         AS resolution_count,
  COALESCE(SUM(pos) FILTER (WHERE is_rolled_back), 0)::float       AS rollback_amount,
  COUNT(*) FILTER (WHERE is_rolled_back)::int                      AS rollback_count,
  COALESCE(SUM(pos) FILTER (WHERE is_normalized), 0)::float        AS normalization_amount,
  COUNT(*) FILTER (WHERE is_normalized)::int                       AS normalization_count,
  COALESCE(SUM(paid) FILTER (WHERE cur_cat = 'npa'), 0)::float     AS recovery_amount,
  COUNT(*) FILTER (WHERE cur_cat = 'npa' AND paid > 0)::int        AS recovery_count,
  COUNT(*) FILTER (WHERE has_trail)::int                           AS trail_count`;

async function classify(
  agencyId: string,
  filters: ReportFilters,
  useTransition: boolean,
): Promise<ClassifiedAggregates> {
  const params: unknown[] = [agencyId, filters.month, useTransition];
  const conditions = baseConditions(filters, params);
  const { rows } = await pool.query(
    `WITH ${classifiedCtes(conditions)}
     SELECT ${AGGREGATE_SELECT} FROM class`,
    params,
  );
  return rows[0] as ClassifiedAggregates;
}

interface TargetValue {
  target_amount: number | null;
  target_count: number | null;
}

/**
 * Target lookup: the row at the effective scope level with the most specific
 * company/product/bucket match wins; when the level has no rows, child-scope
 * rows are summed (agency <- branches <- teams <- agents), first level with
 * rows wins so levels never double-count.
 */
export async function resolveTarget(
  agencyId: string,
  metric: ReportMetric,
  filters: ReportFilters,
): Promise<TargetValue> {
  const dims = (params: unknown[]): string => {
    params.push(filters.company_id ?? null);
    const c = params.length;
    params.push(filters.product ?? null);
    const p = params.length;
    params.push(filters.bucket ?? null);
    const b = params.length;
    return `AND (t.company_id IS NULL OR t.company_id = $${c})
            AND (t.product IS NULL OR lower(t.product) = lower($${p}))
            AND (t.bucket IS NULL OR lower(t.bucket) = lower($${b}))`;
  };

  const exact = async (
    scopeType: string,
    scopeId: string | null,
  ): Promise<TargetValue | null> => {
    const params: unknown[] = [agencyId, filters.month, metric, scopeType];
    let scopeClause = "AND t.scope_id IS NULL";
    if (scopeId) {
      params.push(scopeId);
      scopeClause = `AND t.scope_id = $${params.length}`;
    }
    const dimClause = dims(params);
    const { rows } = await pool.query(
      `SELECT t.target_amount::float, t.target_count
         FROM targets t
        WHERE t.agency_id = $1 AND t.month = $2::date AND t.metric = $3
          AND t.scope_type = $4 ${scopeClause} ${dimClause}
        ORDER BY (t.company_id IS NOT NULL)::int + (t.product IS NOT NULL)::int
                 + (t.bucket IS NOT NULL)::int DESC
        LIMIT 1`,
      params,
    );
    return rows[0] ?? null;
  };

  const childSum = async (
    scopeType: string,
    parentJoinTemplate?: string, // uses $PARENT placeholder for the parent id
    parentId?: string,
  ): Promise<TargetValue | null> => {
    const params: unknown[] = [agencyId, filters.month, metric, scopeType];
    let parentJoin = "";
    if (parentJoinTemplate && parentId) {
      params.push(parentId);
      parentJoin = parentJoinTemplate.replace("$PARENT", `$${params.length}`);
    }
    const dimClause = dims(params);
    const { rows } = await pool.query(
      `SELECT SUM(t.target_amount)::float AS target_amount,
              SUM(t.target_count)::int AS target_count, COUNT(*)::int AS n
         FROM targets t ${parentJoin}
        WHERE t.agency_id = $1 AND t.month = $2::date AND t.metric = $3
          AND t.scope_type = $4 ${dimClause}`,
      params,
    );
    if (!rows[0] || rows[0].n === 0) return null;
    return { target_amount: rows[0].target_amount, target_count: rows[0].target_count };
  };

  /**
   * Phase 8: when nobody has set a manual collection target at any scope
   * level above, fall back to the book's own EMI schedule -- SUM(emi) over
   * the same scope/company/product/bucket filters (never for the other
   * metrics, which are already POS-denominated via the classified
   * aggregates). An empty book returns null, not a fabricated 0.
   */
  const computedDefault = async (): Promise<TargetValue> => {
    if (metric !== "collection") return { target_amount: null, target_count: null };
    const totals = await bookTotals(agencyId, filters);
    return totals.count === 0
      ? { target_amount: null, target_count: null }
      : { target_amount: totals.emi_total, target_count: totals.count };
  };

  if (filters.agent_id) {
    return (await exact("agent", filters.agent_id)) ?? (await computedDefault());
  }
  if (filters.team_id) {
    return (
      (await exact("team", filters.team_id)) ??
      (await childSum(
        "agent",
        "JOIN users u ON u.id = t.scope_id AND u.team_id = $PARENT",
        filters.team_id,
      )) ??
      (await computedDefault())
    );
  }
  if (filters.branch_id) {
    return (
      (await exact("branch", filters.branch_id)) ??
      (await childSum(
        "team",
        "JOIN teams tm ON tm.id = t.scope_id AND tm.branch_id = $PARENT",
        filters.branch_id,
      )) ??
      (await childSum(
        "agent",
        "JOIN users u ON u.id = t.scope_id AND u.branch_id = $PARENT",
        filters.branch_id,
      )) ??
      (await computedDefault())
    );
  }
  return (
    (await exact("agency", null)) ??
    (await childSum("branch")) ??
    (await childSum("team")) ??
    (await childSum("agent")) ??
    (await computedDefault())
  );
}

/** Payment-side filters (deposits card + overview): money in the current scope. */
function paymentConditions(filters: ReportFilters, params: unknown[]): string[] {
  const conditions: string[] = [];
  if (filters.company_id) {
    params.push(filters.company_id);
    conditions.push(`c.company_id = $${params.length}`);
  }
  if (filters.agent_id) {
    params.push(filters.agent_id);
    conditions.push(`p.collected_by_user_id = $${params.length}`);
  }
  if (filters.team_id) {
    params.push(filters.team_id);
    conditions.push(`cu.team_id = $${params.length}`);
  }
  if (filters.branch_id) {
    params.push(filters.branch_id);
    conditions.push(`cu.branch_id = $${params.length}`);
  }
  if (filters.product) {
    params.push(filters.product);
    conditions.push(
      `(lower(c.product) = lower($${params.length}) OR EXISTS (
          SELECT 1 FROM products pr
           WHERE pr.company_id = c.company_id
             AND lower(pr.raw_label) = lower(c.product)
             AND lower(pr.canonical_label) = lower($${params.length})))`,
    );
  }
  if (filters.bucket) {
    params.push(filters.bucket);
    conditions.push(`lower(c.bucket) = lower($${params.length})`);
  }
  return conditions;
}

export interface DepositTotals {
  collected: number;
  deposited: number;
  pending: number;
}

export async function depositsByRange(
  agencyId: string,
  from: string,
  to: string,
  filters: Omit<ReportFilters, "month">,
): Promise<DepositTotals> {
  const params: unknown[] = [agencyId, from, to];
  const conditions = paymentConditions({ ...filters, month: from } as ReportFilters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(p.amount), 0)::float AS collected,
            COALESCE(SUM(p.amount) FILTER (WHERE p.deposited_at IS NOT NULL), 0)::float AS deposited
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${where}`,
    params,
  );
  const collected = rows[0].collected as number;
  const deposited = rows[0].deposited as number;
  return { collected, deposited, pending: roundMoney(collected - deposited) ?? 0 };
}

export interface ExceptionPaymentRow {
  id: string;
  amount: number;
  due_amount: number | null;
  mode: string | null;
  paid_at: string;
  customer_name: string;
  loan_number: string;
  company_name: string;
  collected_by_name: string;
}

/**
 * Phase 6.3: payments.exceeds_due_amount is written on every payment
 * (payments.ts) but was never queried anywhere -- the spot-check signal it
 * was built for (an agent recorded more than what's owed, worth a second
 * look) had no consumer. Same free-date-range + scope-clamp pattern as
 * depositsByRange()/trailAnalytics().
 */
export async function exceptionPayments(
  agencyId: string,
  from: string,
  to: string,
  filters: Omit<ReportFilters, "month">,
): Promise<ExceptionPaymentRow[]> {
  const params: unknown[] = [agencyId, from, to];
  const conditions = paymentConditions({ ...filters, month: from } as ReportFilters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT p.id, p.amount::float AS amount, c.due_amount::float AS due_amount, p.mode, p.paid_at,
            c.customer_name, c.loan_number, co.name AS company_name, cu.full_name AS collected_by_name
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE p.exceeds_due_amount = true
        AND p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${where}
      ORDER BY p.paid_at DESC
      LIMIT 500`,
    params,
  );
  return rows as ExceptionPaymentRow[];
}

// Exported (not just used by dashboard()) so the branch drill-down (Phase 9)
// can pull the same collected/deposited/pending math for a branch_id scope
// without re-deriving the payment-conditions logic.
export async function depositTotals(
  agencyId: string,
  filters: ReportFilters,
): Promise<DepositTotals> {
  const params: unknown[] = [agencyId, filters.month];
  const conditions = paymentConditions(filters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(p.amount), 0)::float AS collected,
            COALESCE(SUM(p.amount) FILTER (WHERE p.deposited_at IS NOT NULL), 0)::float AS deposited
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${where}`,
    params,
  );
  const collected = rows[0].collected as number;
  const deposited = rows[0].deposited as number;
  return { collected, deposited, pending: roundMoney(collected - deposited) ?? 0 };
}

/**
 * Phase 12 (Management Dashboard "Collected Today" KPI): money collected
 * since IST midnight. Previously used bare `now()`, which resolves in the
 * DB session's timezone (UTC) -- wrong for the first ~5.5h of every IST day
 * and liable to bucket a payment into the wrong day entirely. Fixed to use
 * the same `AT TIME ZONE 'Asia/Kolkata'` idiom as depositTotals() above,
 * just anchored to today's IST date instead of a passed-in month. Shares
 * paymentConditions() with the MTD figure so both use identical scope
 * narrowing, just a different time window.
 */
export async function collectedToday(
  agencyId: string,
  filters: ReportFilters,
): Promise<number> {
  const params: unknown[] = [agencyId];
  const conditions = paymentConditions(filters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(p.amount), 0)::float AS today
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE p.paid_at >= (((now() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < (((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${where}`,
    params,
  );
  return rows[0].today as number;
}

export interface PaymentTypeSplit {
  emi: number;
  settlement: number;
}

/** Phase 12 (Management Dashboard "Settlement vs EMI Collections" KPI). */
export async function collectionByType(
  agencyId: string,
  filters: ReportFilters,
): Promise<PaymentTypeSplit> {
  const params: unknown[] = [agencyId, filters.month];
  const conditions = paymentConditions(filters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'settlement'), 0)::float AS settlement,
            COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'emi'), 0)::float AS emi
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${where}`,
    params,
  );
  return { emi: rows[0].emi as number, settlement: rows[0].settlement as number };
}

export interface CollectionChannelSplit {
  field: number;
  telecalling: number;
  /** Collected by someone who is neither a field agent nor a telecaller
   *  (e.g. a TL or admin recording a payment directly) -- not silently
   *  folded into either bucket. */
  other: number;
}

/**
 * Phase 12 (Management Dashboard "Field vs Telecalling Collections" KPI):
 * splits the same MTD collected total by the collecting user's capability
 * flags. A user with both is_field_agent and is_telecaller (unusual but not
 * disallowed) counts toward "field" -- the flag order used everywhere else
 * a single-bucket classification is needed (e.g. /tracking "not moving" alert).
 */
export async function collectionByChannel(
  agencyId: string,
  filters: ReportFilters,
): Promise<CollectionChannelSplit> {
  const params: unknown[] = [agencyId, filters.month];
  const conditions = paymentConditions(filters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT
        COALESCE(SUM(p.amount) FILTER (WHERE cu.is_field_agent), 0)::float AS field,
        COALESCE(SUM(p.amount) FILTER (WHERE NOT cu.is_field_agent AND cu.is_telecaller), 0)::float AS telecalling,
        COALESCE(SUM(p.amount) FILTER (WHERE NOT cu.is_field_agent AND NOT cu.is_telecaller), 0)::float AS other
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${where}`,
    params,
  );
  return {
    field: rows[0].field as number,
    telecalling: rows[0].telecalling as number,
    other: rows[0].other as number,
  };
}

export interface TrendPoint {
  bucket: string; // 'YYYY-MM-DD' (day) or the Monday of the ISO week (week)
  amount: number;
}

/**
 * Phase 12 (Management Dashboard "Recovery Trend" KPI): daily or weekly
 * collected-amount buckets over a free date range, same payment scope
 * narrowing as the rest of the payment-side report surface.
 */
export async function collectionTrend(
  agencyId: string,
  from: string,
  to: string,
  granularity: "day" | "week",
  filters: Omit<ReportFilters, "month">,
): Promise<TrendPoint[]> {
  const params: unknown[] = [agencyId, from, to];
  const conditions = paymentConditions({ ...filters, month: from } as ReportFilters, params);
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const truncUnit = granularity === "week" ? "week" : "day";
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('${truncUnit}', p.paid_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket,
            COALESCE(SUM(p.amount), 0)::float AS amount
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${where}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  return rows as TrendPoint[];
}

export interface DepositRow {
  id: string;
  amount: number;
  mode: string | null;
  paid_at: string;
  deposited_at: string | null;
  customer_name: string;
  loan_number: string;
  company_name: string;
  collected_by_name: string;
  deposited_by_name: string | null;
}

export interface DepositListFilters {
  deposited?: boolean;
  month?: string; // 'YYYY-MM-01'
  agent_id?: string;
  company_id?: string;
  branch_id?: string;
  limit?: number;
}

/**
 * Individual payment rows behind the deposit reconciliation UI (Phase 5.4)
 * and the branch drill-down's Deposits section (Phase 9) -- factored out of
 * the /payments/deposits route so both share one query instead of drifting.
 * branch_id filters by the COLLECTING agent's branch (u.branch_id), the same
 * "credit whoever recorded the payment" semantic paymentConditions() uses.
 */
export async function listDeposits(
  agencyId: string,
  filters: DepositListFilters,
): Promise<DepositRow[]> {
  const conditions = ["co.agency_id = $1"];
  const params: unknown[] = [agencyId];
  if (filters.deposited === true) conditions.push("p.deposited_at IS NOT NULL");
  if (filters.deposited === false) conditions.push("p.deposited_at IS NULL");
  if (filters.month) {
    params.push(filters.month);
    conditions.push(
      `p.paid_at >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND p.paid_at < ((($${params.length}::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  if (filters.agent_id) {
    params.push(filters.agent_id);
    conditions.push(`p.collected_by_user_id = $${params.length}`);
  }
  if (filters.company_id) {
    params.push(filters.company_id);
    conditions.push(`c.company_id = $${params.length}`);
  }
  if (filters.branch_id) {
    params.push(filters.branch_id);
    conditions.push(`u.branch_id = $${params.length}`);
  }
  params.push(filters.limit ?? 500);

  const { rows } = await pool.query(
    `SELECT p.id, p.amount, p.mode, p.paid_at, p.deposited_at,
            c.customer_name, c.loan_number, co.name AS company_name,
            u.full_name AS collected_by_name,
            du.full_name AS deposited_by_name
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id
       JOIN users u ON u.id = p.collected_by_user_id
       LEFT JOIN users du ON du.id = p.deposited_by_user_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.paid_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows as DepositRow[];
}

export interface MetricBlock {
  basis: "transition" | "payments";
  allocated_amount: number;
  allocated_count: number;
  target_amount: number | null;
  target_count: number | null;
  target_pct: number | null;
  mtd_amount: number;
  mtd_count: number;
  mtd_pct: number | null;
  run_rate_current: number | null;
  run_rate_required: number | null;
  away_amount: number | null;
  away_count: number | null;
}

export interface DashboardResult {
  month: string;
  days: MonthDays;
  scope: { clamped_to: string };
  allocated: { amount: number; count: number };
  metrics: Record<Exclude<ReportMetric, "collection">, MetricBlock>;
  collection: {
    mtd_amount: number;
    target_amount: number | null;
    target_pct: number | null;
    run_rate_current: number | null;
    run_rate_required: number | null;
    /** Phase 8: total principal outstanding of the scope's book -- context
     *  for the target, never baked into it. */
    pos_total: number;
    /** target_amount as a % of pos_total -- how much of the book's
     *  outstanding principal this month's EMI target represents. */
    emi_over_pos_pct: number | null;
    /** Phase 12: money collected since midnight UTC (see collectedToday()). */
    today_amount: number;
    /** Phase 12: MTD collected split by payment.type. */
    by_type: PaymentTypeSplit;
    /** Phase 12: MTD collected split by the collecting user's capability. */
    by_channel: CollectionChannelSplit;
  };
  deposits: DepositTotals;
  trail: { allocated_count: number; uploaded_count: number; pct: number | null };
}

const pct = (num: number, den: number | null | undefined): number | null =>
  den && den > 0 ? Math.round((num / den) * 10000) / 100 : null;

/**
 * SQL SUM(NUMERIC) is exact; once a value crosses into JS float64 (every
 * ::float cast, and any subtraction/division performed here in JS) it can
 * carry trailing floating-point noise -- e.g. 12999.999999999998 instead of
 * 13000. At this system's real scale (dozens to low-thousands of rows, not
 * millions) that noise never compounds into a paisa-level discrepancy, but
 * it's still worth rounding away before a figure reaches an API response or
 * a screen. Applied only to values computed here (subtraction, division) --
 * raw single-aggregate passthroughs from SQL don't need it.
 */
const roundMoney = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);

export async function dashboard(
  user: UserRow,
  requested: ReportFilters,
  hasFullView: boolean,
): Promise<DashboardResult> {
  const scope = await resolveReportScope(user, requested, hasFullView);
  const filters = scope.filters;
  const days = monthDays(filters.month.slice(0, 7));
  const useTransition = await hasNextMonthSnapshot(user.agency_id, filters);
  // classify() and depositTotals() depend on nothing but filters/useTransition
  // -- previously sequential for no reason.
  const [agg, deposits] = await Promise.all([
    classify(user.agency_id, filters, useTransition),
    depositTotals(user.agency_id, filters),
  ]);

  const basisOf = (metric: ReportMetric): "transition" | "payments" =>
    metric === "recovery" ? "payments" : useTransition ? "transition" : "payments";

  const block = async (
    metric: Exclude<ReportMetric, "collection">,
    mtdAmount: number,
    mtdCount: number,
    allocatedAmount: number,
    allocatedCount: number,
  ): Promise<MetricBlock> => {
    const target = await resolveTarget(user.agency_id, metric, filters);
    const runRateCurrent = days.elapsed > 0 ? roundMoney(mtdAmount / days.elapsed) : null;
    const remaining = target.target_amount != null ? Math.max(target.target_amount - mtdAmount, 0) : null;
    return {
      basis: basisOf(metric),
      allocated_amount: allocatedAmount,
      allocated_count: allocatedCount,
      target_amount: target.target_amount,
      target_count: target.target_count,
      target_pct: target.target_amount != null ? pct(target.target_amount, allocatedAmount) : null,
      mtd_amount: mtdAmount,
      mtd_count: mtdCount,
      mtd_pct: pct(mtdAmount, allocatedAmount),
      run_rate_current: runRateCurrent,
      run_rate_required: remaining != null && days.left > 0 ? roundMoney(remaining / days.left) : null,
      away_amount: roundMoney(remaining),
      away_count: target.target_count != null ? Math.max(target.target_count - mtdCount, 0) : null,
    };
  };

  const [collectionTarget, collectionBook, todayAmount, byType, byChannel, resolutionBlock, rollbackBlock, normalizationBlock, recoveryBlock] =
    await Promise.all([
      resolveTarget(user.agency_id, "collection", filters),
      bookTotals(user.agency_id, filters),
      collectedToday(user.agency_id, filters),
      collectionByType(user.agency_id, filters),
      collectionByChannel(user.agency_id, filters),
      // The four metric blocks each call resolveTarget() independently with
      // a different metric -- previously four sequential await block(...)
      // calls inside the object literal below, now run together.
      block("resolution", agg.resolution_amount, agg.resolution_count, agg.allocated_amount, agg.allocated_count),
      block("rollback", agg.rollback_amount, agg.rollback_count, agg.allocated_amount, agg.allocated_count),
      block("normalization", agg.normalization_amount, agg.normalization_count, agg.allocated_amount, agg.allocated_count),
      block("recovery", agg.recovery_amount, agg.recovery_count, agg.recovery_allocated_amount, agg.recovery_allocated_count),
    ]);

  return {
    month: filters.month.slice(0, 7),
    days,
    scope: { clamped_to: scope.clampedTo },
    allocated: { amount: agg.allocated_amount, count: agg.allocated_count },
    metrics: {
      resolution: resolutionBlock,
      rollback: rollbackBlock,
      normalization: normalizationBlock,
      recovery: recoveryBlock,
    },
    collection: {
      // Use deposits.collected (paymentConditions-based) — attributes to whoever
      // recorded the payment, not to the allocated agent (classifiedCtes bug).
      mtd_amount: deposits.collected,
      target_amount: collectionTarget.target_amount,
      target_pct: pct(deposits.collected, collectionTarget.target_amount),
      run_rate_current: days.elapsed > 0 ? roundMoney(deposits.collected / days.elapsed) : null,
      run_rate_required:
        collectionTarget.target_amount != null
          ? roundMoney(Math.max(collectionTarget.target_amount - deposits.collected, 0) / Math.max(days.left, 1))
          : null,
      pos_total: collectionBook.pos_total,
      emi_over_pos_pct:
        collectionTarget.target_amount != null
          ? pct(collectionTarget.target_amount, collectionBook.pos_total)
          : null,
      today_amount: todayAmount,
      by_type: byType,
      by_channel: byChannel,
    },
    deposits,
    trail: {
      allocated_count: agg.allocated_count,
      uploaded_count: agg.trail_count,
      pct: pct(agg.trail_count, agg.allocated_count),
    },
  };
}

export interface OverviewPoint {
  month: string;
  collected: number;
}

export async function overview(
  user: UserRow,
  requested: Omit<ReportFilters, "month">,
  hasFullView: boolean,
  months: number | "all",
): Promise<{ total: number; points: OverviewPoint[] }> {
  const scope = await resolveReportScope(user, { ...requested, month: "2000-01-01" }, hasFullView);
  const params: unknown[] = [user.agency_id];
  const conditions = paymentConditions(scope.filters, params);
  let monthLimit = "";
  if (months !== "all") {
    params.push(months);
    monthLimit = `AND p.paid_at >= ((date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))
                    - make_interval(months => $${params.length}::int - 1))::timestamp AT TIME ZONE 'Asia/Kolkata')`;
  }
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', p.paid_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month,
            SUM(p.amount)::float AS collected
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
      WHERE true ${monthLimit} ${where}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  const points = rows as OverviewPoint[];
  return { total: roundMoney(points.reduce((sum, p) => sum + p.collected, 0)) ?? 0, points };
}

export interface AgentReportRow {
  agent_id: string;
  full_name: string;
  team_name: string | null;
  allocated_amount: number;
  allocated_count: number;
  collected_amount: number;
  resolution_amount: number;
  rollback_amount: number;
  normalization_amount: number;
  recovery_amount: number;
  trail_count: number;
  target_amount: number | null;
  achievement_pct: number | null;
}

export async function agentBreakdown(
  user: UserRow,
  requested: ReportFilters,
  hasFullView: boolean,
): Promise<AgentReportRow[]> {
  const scope = await resolveReportScope(user, requested, hasFullView);
  const filters = scope.filters;
  const useTransition = await hasNextMonthSnapshot(user.agency_id, filters);

  const params: unknown[] = [user.agency_id, filters.month, useTransition];
  const conditions = baseConditions(filters, params);
  const { rows } = await pool.query(
    `WITH ${classifiedCtes(conditions)}
     SELECT class.assigned_agent_id AS agent_id, ${AGGREGATE_SELECT}
       FROM class
      WHERE class.assigned_agent_id IS NOT NULL
      GROUP BY class.assigned_agent_id`,
    params,
  );

  // Separately query collected amounts by who actually recorded the payment
  // (paymentConditions uses p.collected_by_user_id, unlike classifiedCtes which uses allocated agent).
  const payParams: unknown[] = [user.agency_id, filters.month];
  const payConditions = paymentConditions(filters, payParams);
  const payWhere = payConditions.length > 0 ? `AND ${payConditions.join(" AND ")}` : "";
  const { rows: collectedRows } = await pool.query(
    `SELECT p.collected_by_user_id AS agent_id, MAX(cu.full_name) AS full_name, MAX(tm.name) AS team_name, SUM(p.amount)::float AS collected_amount
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
       LEFT JOIN teams tm ON tm.id = cu.team_id
      WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        ${payWhere}
      GROUP BY 1`,
    payParams,
  );
  const collectedByAgent = new Map<string, { collected_amount: number; full_name: string; team_name: string | null }>(
    collectedRows.map((r) => [
      String(r.agent_id),
      {
        collected_amount: r.collected_amount as number,
        full_name: r.full_name as string,
        team_name: r.team_name as string | null,
      },
    ]),
  );

  // All the agent rows' names/teams in one query instead of one round-trip
  // per agent -- 30 agents previously meant 30 near-identical single-row
  // lookups here alone, on top of the per-agent resolveTarget() calls below.
  const allAgentIds = Array.from(new Set([...rows.map((r) => String(r.agent_id)), ...collectedByAgent.keys()]));
  const { rows: agentInfoRows } = await pool.query<{ id: string; full_name: string; team_name: string | null }>(
    `SELECT u.id, u.full_name, tm.name AS team_name FROM users u
      LEFT JOIN teams tm ON tm.id = u.team_id WHERE u.id = ANY($1::uuid[])`,
    [allAgentIds],
  );
  const agentInfoById = new Map(agentInfoRows.map((r) => [r.id, r]));

  const result: AgentReportRow[] = [];
  const processedAgentIds = new Set<string>();

  for (const row of rows) {
    const agentIdStr = String(row.agent_id);
    processedAgentIds.add(agentIdStr);
    const agentInfo = agentInfoById.get(agentIdStr);
    const target = await resolveTarget(user.agency_id, "collection", {
      ...filters,
      agent_id: row.agent_id as string,
    });
    const collectedInfo = collectedByAgent.get(agentIdStr);
    const actualCollected = collectedInfo?.collected_amount ?? 0;
    result.push({
      agent_id: row.agent_id,
      full_name: agentInfo?.full_name ?? "—",
      team_name: agentInfo?.team_name ?? null,
      allocated_amount: row.allocated_amount,
      allocated_count: row.allocated_count,
      collected_amount: actualCollected,
      resolution_amount: row.resolution_amount,
      rollback_amount: row.rollback_amount,
      normalization_amount: row.normalization_amount,
      recovery_amount: row.recovery_amount,
      trail_count: row.trail_count,
      target_amount: target.target_amount,
      achievement_pct: pct(actualCollected, target.target_amount),
    });
  }

  for (const [agentIdStr, collectedInfo] of collectedByAgent.entries()) {
    if (!processedAgentIds.has(agentIdStr)) {
      const target = await resolveTarget(user.agency_id, "collection", {
        ...filters,
        agent_id: agentIdStr,
      });
      result.push({
        agent_id: agentIdStr,
        full_name: collectedInfo.full_name ?? "—",
        team_name: collectedInfo.team_name ?? null,
        allocated_amount: 0,
        allocated_count: 0,
        collected_amount: collectedInfo.collected_amount,
        resolution_amount: 0,
        rollback_amount: 0,
        normalization_amount: 0,
        recovery_amount: 0,
        trail_count: 0,
        target_amount: target.target_amount,
        achievement_pct: pct(collectedInfo.collected_amount, target.target_amount),
      });
    }
  }

  result.sort((a, b) => b.collected_amount - a.collected_amount);
  return result;
}

export type BreakdownDimension = "company" | "product" | "bucket" | "branch" | "team" | "agent";

export interface BreakdownRow {
  key: string | null;
  label: string;
  allocated_amount: number;
  allocated_count: number;
  collected_amount: number;
  /**
   * For branch/team/agent: money collected by staff belonging to this row
   * (the collector's OWN branch/team/self), which can differ from
   * `collected_amount` (money collected against THIS row's allocated book,
   * regardless of who collected it) whenever the collecting agent isn't
   * from the same branch/team as the book -- multi-branch telecallers,
   * reallocation mid-month, or a manager recording on an agent's behalf.
   * Equal to `collected_amount` for company/product/bucket, where both
   * queries group by the same intrinsic customer property.
   */
  collected_by_own_staff_amount: number;
  resolution_amount: number;
  resolution_pct: number | null;
  rollback_amount: number;
  rollback_pct: number | null;
  normalization_amount: number;
  normalization_pct: number | null;
  recovery_amount: number;
  recovery_pct: number | null;
  trail_pct: number | null;
  target_amount: number | null;
  achievement_pct: number | null;
}

const DIMENSION_GROUP: Record<BreakdownDimension, { group: string; label: string }> = {
  company: { group: "class.company_id", label: "MAX(class.company_name)" },
  product: { group: "class.canonical_product", label: "MAX(class.canonical_product)" },
  bucket: { group: "class.bucket", label: "MAX(class.bucket)" },
  branch: { group: "class.branch_id", label: "MAX(class.branch_name)" },
  team: { group: "class.assigned_team_id", label: "MAX(class.team_name)" },
  agent: { group: "class.assigned_agent_id", label: "MAX(class.agent_name)" },
};

/**
 * Per-dimension slice of the same classification used by the dashboard and
 * agent breakdown (brief §15's "product wise view" and friends). Targets are
 * only meaningful for organizational dimensions (company/branch/team/agent)
 * -- product/bucket are cross-cutting narrowing filters in the targets model,
 * not their own scope level, so those rows carry a null target.
 */
export async function dimensionBreakdown(
  user: UserRow,
  requested: ReportFilters,
  hasFullView: boolean,
  dimension: BreakdownDimension,
): Promise<BreakdownRow[]> {
  const scope = await resolveReportScope(user, requested, hasFullView);
  const filters = scope.filters;
  const useTransition = await hasNextMonthSnapshot(user.agency_id, filters);
  const params: unknown[] = [user.agency_id, filters.month, useTransition];
  const conditions = baseConditions(filters, params);
  const dim = DIMENSION_GROUP[dimension];
  const orderBy = dimension === "bucket" ? "MIN(class.cur_sort) ASC NULLS LAST" : "allocated_amount DESC";

  const { rows } = await pool.query(
    `WITH ${classifiedCtes(conditions)}
     SELECT ${dim.group} AS key, ${dim.label} AS label, ${AGGREGATE_SELECT}
       FROM class
      WHERE ${dim.group} IS NOT NULL
      GROUP BY ${dim.group}
      ORDER BY ${orderBy}`,
    params,
  );

  // Separately sum collected amounts by who actually recorded the payment,
  // grouped by the same dimension (org dimensions use the collector's own branch/team,
  // not the book's allocated team — a deliberate semantic shift for accurate credit).
  const DIM_PAYMENT_GROUP: Record<BreakdownDimension, string> = {
    agent:   "p.collected_by_user_id",
    team:    "cu.team_id",
    branch:  "cu.branch_id",
    company: "c.company_id",
    product: "c.product",
    bucket:  "c.bucket",
  };
  const DIM_PAYMENT_LABEL: Record<BreakdownDimension, string> = {
    agent:   "MAX(cu.full_name)",
    team:    "MAX(ct.name)",
    branch:  "MAX(cbr.name)",
    company: "MAX(co.name)",
    product: "MAX(c.product)",
    bucket:  "MAX(c.bucket)",
  };
  const payParams: unknown[] = [user.agency_id, filters.month];
  const payConditions = paymentConditions(filters, payParams);
  const payWhere = payConditions.length > 0 ? `AND ${payConditions.join(" AND ")}` : "";
  const dimPayGroup = DIM_PAYMENT_GROUP[dimension];
  const dimPayLabel = DIM_PAYMENT_LABEL[dimension];
  const { rows: collectedRows } = await pool.query(
    `SELECT ${dimPayGroup} AS key, ${dimPayLabel} AS label, SUM(p.amount)::float AS collected_amount
       FROM payments p
       JOIN customers c ON c.id = p.customer_id
       JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
       JOIN users cu ON cu.id = p.collected_by_user_id
       LEFT JOIN teams ct ON ct.id = cu.team_id
       LEFT JOIN branches cbr ON cbr.id = cu.branch_id
      WHERE p.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND p.paid_at < ((($2::date + interval '1 month')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND ${dimPayGroup} IS NOT NULL
        ${payWhere}
      GROUP BY 1`,
    payParams,
  );
  const collectedByDim = new Map<string, { collected_amount: number; label: string }>(
    collectedRows.map((r) => [String(r.key), { collected_amount: r.collected_amount as number, label: r.label as string }]),
  );

  const isOrgDimension =
    dimension === "company" || dimension === "branch" || dimension === "team" || dimension === "agent";
  const result: BreakdownRow[] = [];
  const processedKeys = new Set<string>();

  for (const row of rows) {
    const keyStr = String(row.key);
    processedKeys.add(keyStr);
    let target: TargetValue = { target_amount: null, target_count: null };
    if (isOrgDimension) {
      const scopeFilter: ReportFilters = { ...filters };
      if (dimension === "company") scopeFilter.company_id = row.key;
      if (dimension === "branch") scopeFilter.branch_id = row.key;
      if (dimension === "team") scopeFilter.team_id = row.key;
      if (dimension === "agent") scopeFilter.agent_id = row.key;
      target = await resolveTarget(user.agency_id, "collection", scopeFilter);
    }
    const collectedInfo = collectedByDim.get(keyStr);
    const collectedByOwnStaff = collectedInfo?.collected_amount ?? 0;
    result.push({
      key: row.key,
      label: row.label ?? "—",
      allocated_amount: row.allocated_amount,
      allocated_count: row.allocated_count,
      // row.collected_amount comes from the SAME classified/allocated
      // population as allocated_amount and the resolution/rollback/
      // normalization/recovery figures below -- previously this was
      // overwritten with collectedByOwnStaff (a differently-scoped,
      // collector-grouped figure), so achievement_pct ended up dividing a
      // "money collected by this branch/team/agent's own staff" numerator
      // by a "target set for this branch/team/agent's allocated book"
      // denominator: two different populations for the same labeled row.
      collected_amount: row.collected_amount,
      collected_by_own_staff_amount: collectedByOwnStaff,
      resolution_amount: row.resolution_amount,
      resolution_pct: pct(row.resolution_amount, row.allocated_amount),
      rollback_amount: row.rollback_amount,
      rollback_pct: pct(row.rollback_amount, row.allocated_amount),
      normalization_amount: row.normalization_amount,
      normalization_pct: pct(row.normalization_amount, row.allocated_amount),
      recovery_amount: row.recovery_amount,
      recovery_pct: pct(row.recovery_amount, row.recovery_allocated_amount),
      trail_pct: pct(row.trail_count, row.allocated_count),
      target_amount: target.target_amount,
      achievement_pct: pct(row.collected_amount, target.target_amount),
    });
  }

  // Include entities that have collections but no allocated book in this month
  for (const [key, collectedInfo] of collectedByDim.entries()) {
    if (!processedKeys.has(key)) {
      let target: TargetValue = { target_amount: null, target_count: null };
      if (isOrgDimension) {
        const scopeFilter: ReportFilters = { ...filters };
        if (dimension === "company") scopeFilter.company_id = key;
        if (dimension === "branch") scopeFilter.branch_id = key;
        if (dimension === "team") scopeFilter.team_id = key;
        if (dimension === "agent") scopeFilter.agent_id = key;
        target = await resolveTarget(user.agency_id, "collection", scopeFilter);
      }
      
      const unallocatedCollectedAmount = (!isOrgDimension || dimension === "company") 
        ? collectedInfo.collected_amount 
        : 0;

      result.push({
        key,
        label: collectedInfo.label ?? "—",
        allocated_amount: 0,
        allocated_count: 0,
        collected_amount: unallocatedCollectedAmount,
        collected_by_own_staff_amount: collectedInfo.collected_amount,
        resolution_amount: 0,
        resolution_pct: null,
        rollback_amount: 0,
        rollback_pct: null,
        normalization_amount: 0,
        normalization_pct: null,
        recovery_amount: 0,
        recovery_pct: null,
        trail_pct: null,
        target_amount: target.target_amount,
        achievement_pct: pct(unallocatedCollectedAmount, target.target_amount),
      });
    }
  }

  // For unallocated entries appended at the end, sorting might be slightly off.
  // But since allocated_amount is 0, they belong at the end anyway (ORDER BY allocated_amount DESC).
  // For bucket dimension, they would normally be sorted by cur_sort ASC, so we can re-sort.
  if (dimension === "bucket") {
    // If we wanted to sort by bucket, we could, but 'No Data' buckets or unallocated buckets 
    // without a cur_sort just go at the end.
  }

  return result;
}

export interface TrailAnalytics {
  from: string;
  to: string;
  total_trails: number;
  unique_customers_contacted: number;
  by_action_code: { action_code: string; count: number }[];
  by_result_code: { result_code: string; count: number }[];
  ptps_created: number;
  ptps_kept: number;
  ptps_broken: number;
  ptps_pending: number;
  /** Phase 12 (Management Dashboard "PTP Value" KPI): sum of amount on
   *  still-pending PTPs created in this range -- money promised but not yet
   *  due to have resolved either way. */
  ptps_pending_value: number;
  ptp_conversion_pct: number | null; // kept / (kept + broken)
  /** Phase 12 (Telecaller dashboard "Escalation Cases" KPI): calls
   *  dispositioned under the seeded 'ESCALATED CASE' category. */
  escalated_count: number;
}

/** Date-range trail/disposition analytics (event-level, so a range fits naturally here). */
export async function trailAnalytics(
  agencyId: string,
  from: string,
  to: string,
  filters: Omit<ReportFilters, "month">,
): Promise<TrailAnalytics> {
  // Unlike every other date-range query in this file (e.g. depositsByRange
  // above), this comparison had no `AT TIME ZONE 'Asia/Kolkata'` -- so the
  // trail report's day boundaries were UTC while the dashboard's were IST,
  // misattributing calls made in the last ~5.5h of an IST day to the next
  // day's report.
  const conditions = [
    "co.agency_id = $1",
    "cl.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')",
    "cl.created_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')",
  ];
  const params: unknown[] = [agencyId, from, to];
  if (filters.company_id) {
    params.push(filters.company_id);
    conditions.push(`c.company_id = $${params.length}`);
  }
  // `u` (cl.agent_id) is already joined in every query below -- branch_id
  // was previously silently ignored here, which is how a branch_manager's
  // scope clamp (branch_id set, team_id undefined) fell through to
  // agency-wide trail data despite resolveReportScope() having narrowed it.
  if (filters.branch_id) {
    params.push(filters.branch_id);
    conditions.push(
      `(u.branch_id = $${params.length} OR EXISTS (SELECT 1 FROM telecaller_branches tb WHERE tb.user_id = u.id AND tb.branch_id = $${params.length}))`,
    );
  }
  if (filters.team_id) {
    params.push(filters.team_id);
    conditions.push(`u.team_id = $${params.length}`);
  }
  if (filters.agent_id) {
    params.push(filters.agent_id);
    conditions.push(`cl.agent_id = $${params.length}`);
  }
  if (filters.product) {
    params.push(filters.product);
    conditions.push(`lower(c.product) = lower($${params.length})`);
  }
  if (filters.bucket) {
    params.push(filters.bucket);
    conditions.push(`lower(c.bucket) = lower($${params.length})`);
  }
  const where = conditions.join(" AND ");

  const [totals, byAction, byResult, ptps] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT cl.customer_id)::int AS unique_customers,
              COUNT(*) FILTER (WHERE dc.category = 'ESCALATED CASE')::int AS escalated_count
         FROM call_logs cl
         JOIN customers c ON c.id = cl.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = cl.agent_id
         LEFT JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
        WHERE ${where}`,
      params,
    ),
    pool.query(
      `SELECT dc.action_code, COUNT(*)::int AS count
         FROM call_logs cl
         JOIN customers c ON c.id = cl.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = cl.agent_id
         JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
        WHERE ${where}
        GROUP BY dc.action_code ORDER BY count DESC`,
      params,
    ),
    pool.query(
      `SELECT dc.result_code, COUNT(*)::int AS count
         FROM call_logs cl
         JOIN customers c ON c.id = cl.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = cl.agent_id
         JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
        WHERE ${where} AND dc.result_code IS NOT NULL
        GROUP BY dc.result_code ORDER BY count DESC`,
      params,
    ),
    pool.query(
      `SELECT p.status, COUNT(*)::int AS count, COALESCE(SUM(p.amount), 0)::float AS amount
         FROM ptps p
         JOIN call_logs cl ON cl.id = p.call_log_id
         JOIN customers c ON c.id = cl.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = cl.agent_id
        WHERE ${where}
        GROUP BY p.status`,
      params,
    ),
  ]);

  const ptpCounts: Record<string, number> = { pending: 0, kept: 0, broken: 0 };
  const ptpAmounts: Record<string, number> = { pending: 0, kept: 0, broken: 0 };
  for (const r of ptps.rows) {
    ptpCounts[r.status as string] = r.count as number;
    ptpAmounts[r.status as string] = r.amount as number;
  }
  const ptpsCreated = ptpCounts.pending + ptpCounts.kept + ptpCounts.broken;

  return {
    from,
    to,
    total_trails: totals.rows[0].total,
    unique_customers_contacted: totals.rows[0].unique_customers,
    by_action_code: byAction.rows as { action_code: string; count: number }[],
    by_result_code: byResult.rows as { result_code: string; count: number }[],
    ptps_created: ptpsCreated,
    ptps_kept: ptpCounts.kept,
    ptps_broken: ptpCounts.broken,
    ptps_pending: ptpCounts.pending,
    ptps_pending_value: ptpAmounts.pending,
    ptp_conversion_pct: pct(ptpCounts.kept, ptpCounts.kept + ptpCounts.broken),
    escalated_count: totals.rows[0].escalated_count,
  };
}

export interface RecallReportRow {
  company_id: string;
  company_name: string;
  recalled_count: number;
  recalled_amount: number;
}

export interface RecalledCustomerRow {
  customer_id: string;
  loan_number: string;
  customer_name: string;
  company_name: string;
  recalled_at: string;
  last_bucket: string | null;
  last_due_amount: number | null;
  last_pos: number | null;
  last_agent_name: string | null;
}

export interface RecallReport {
  month: string;
  by_company: RecallReportRow[];
  customers: RecalledCustomerRow[];
  total_recalled_count: number;
  total_recalled_amount: number;
  lifetime_recalled_count: number;
}

/** Recalled cases (Phase 7 discrepancy review) -- a distinct fact from `closed`, reported separately. */
export async function recallReport(
  agencyId: string,
  month: string,
  companyId?: string,
  branchId?: string,
): Promise<RecallReport> {
  // Recalling a customer clears assigned_agent_id/assigned_team_id (see
  // import-reviews.ts), so the only signal reportBranchClause() has left to
  // work with here is the customer's own structured branch_id/custom_fields
  // (its team/agent-EXISTS arms just never match for a recalled row -- still
  // harmless to include for consistency with the other report-service call
  // sites).
  const params: unknown[] = [agencyId, month];
  let companyClause = "";
  if (companyId) {
    params.push(companyId);
    companyClause = `AND c.company_id = $${params.length}`;
  }
  const branchClause = branchId
    ? `AND ${reportBranchClause(branchId, params, "c", null, ["c.assigned_agent_id", "c.assigned_field_agent_id"])}`
    : "";
  const byCompany = await pool.query(
    `SELECT c.company_id, co.name AS company_name,
            COUNT(*)::int AS recalled_count,
            COALESCE(SUM(c.due_amount), 0)::float AS recalled_amount
       FROM customers c
       JOIN companies co ON co.id = c.company_id
      WHERE co.agency_id = $1 AND c.status = 'recalled'
        AND c.recalled_at >= $2::date AND c.recalled_at < ($2::date + interval '1 month')
        ${companyClause} ${branchClause}
      GROUP BY c.company_id, co.name
      ORDER BY recalled_count DESC`,
    params,
  );
  // Independent param numbering from the byCompany query above -- that one's
  // companyClause references $3 (built after month occupies $2), which
  // doesn't exist in this two-param query.
  const lifetimeParams: unknown[] = [agencyId];
  let lifetimeCompanyClause = "";
  if (companyId) {
    lifetimeParams.push(companyId);
    lifetimeCompanyClause = `AND c.company_id = $${lifetimeParams.length}`;
  }
  const lifetimeBranchClause = branchId
    ? `AND ${reportBranchClause(branchId, lifetimeParams, "c", null, ["c.assigned_agent_id", "c.assigned_field_agent_id"])}`
    : "";
  const lifetime = await pool.query(
    `SELECT COUNT(*)::int AS n FROM customers c
       JOIN companies co ON co.id = c.company_id
      WHERE co.agency_id = $1 AND c.status = 'recalled' ${lifetimeCompanyClause} ${lifetimeBranchClause}`,
    lifetimeParams,
  );

  // Detailed downloadable list, same month window as by_company above -- its
  // own independent param array, same reason as lifetimeParams.
  const detailParams: unknown[] = [agencyId, month];
  let detailCompanyClause = "";
  if (companyId) {
    detailParams.push(companyId);
    detailCompanyClause = `AND c.company_id = $${detailParams.length}`;
  }
  const detailBranchClause = branchId
    ? `AND ${reportBranchClause(branchId, detailParams, "c", null, ["c.assigned_agent_id", "c.assigned_field_agent_id"])}`
    : "";
  const customerRows = await pool.query(
    `SELECT c.id AS customer_id, c.loan_number, c.customer_name, co.name AS company_name,
            c.recalled_at, c.bucket AS last_bucket, c.due_amount::float AS last_due_amount,
            c.pos::float AS last_pos,
            (SELECT u.full_name FROM allocation_logs al
               JOIN users u ON u.id = al.to_agent_id
              WHERE al.customer_id = c.id
              ORDER BY al.created_at DESC LIMIT 1) AS last_agent_name
       FROM customers c
       JOIN companies co ON co.id = c.company_id
      WHERE co.agency_id = $1 AND c.status = 'recalled'
        AND c.recalled_at >= $2::date AND c.recalled_at < ($2::date + interval '1 month')
        ${detailCompanyClause} ${detailBranchClause}
      ORDER BY c.recalled_at DESC`,
    detailParams,
  );

  const rows = byCompany.rows as RecallReportRow[];
  return {
    month: month.slice(0, 7),
    by_company: rows,
    customers: customerRows.rows as RecalledCustomerRow[],
    total_recalled_count: rows.reduce((s, r) => s + r.recalled_count, 0),
    total_recalled_amount: roundMoney(rows.reduce((s, r) => s + r.recalled_amount, 0)) ?? 0,
    lifetime_recalled_count: lifetime.rows[0].n,
  };
}

export interface BucketMovementReportRow {
  company_id: string;
  company_name: string;
  bucket: string;
  payment_detected: number;
  allocation_confirmed: number;
  detected_not_confirmed: number;
}

/**
 * Payment-detected normalizations vs. allocation-confirmed ones, per
 * company/bucket. "Detected but not confirmed" is the owner-level insight:
 * in-house signal the lender's next file hasn't (yet) agreed with.
 */
export async function bucketMovementReport(
  agencyId: string,
  month: string,
  companyId?: string,
  branchId?: string,
): Promise<{ month: string; rows: BucketMovementReportRow[] }> {
  const params: unknown[] = [agencyId, month];
  let companyClause = "";
  if (companyId) {
    params.push(companyId);
    companyClause = `AND bm.company_id = $${params.length}`;
  }
  // bucket_movements has no branch/team/agent columns of its own -- clamp via
  // the customer it's about.
  const branchClause = branchId
    ? `AND ${reportBranchClause(branchId, params, "c", null, ["c.assigned_agent_id", "c.assigned_field_agent_id"])}`
    : "";
  const { rows } = await pool.query(
    `SELECT bm.company_id, co.name AS company_name, bm.from_bucket AS bucket,
            COUNT(*) FILTER (WHERE bm.trigger = 'payment')::int AS payment_detected,
            COUNT(*) FILTER (WHERE bm.trigger = 'allocation')::int AS allocation_confirmed,
            COUNT(*) FILTER (
              WHERE bm.trigger = 'payment' AND NOT EXISTS (
                SELECT 1 FROM bucket_movements c2
                 WHERE c2.customer_id = bm.customer_id AND c2.trigger = 'allocation'
                   AND c2.month >= bm.month
              )
            )::int AS detected_not_confirmed
       FROM bucket_movements bm
       JOIN companies co ON co.id = bm.company_id
       JOIN customers c ON c.id = bm.customer_id
      WHERE co.agency_id = $1 AND bm.month = $2::date ${companyClause} ${branchClause}
      GROUP BY bm.company_id, co.name, bm.from_bucket
      ORDER BY co.name, bm.from_bucket`,
    params,
  );
  return { month: month.slice(0, 7), rows: rows as BucketMovementReportRow[] };
}

export interface BucketMismatchRow {
  customer_id: string;
  loan_number: string;
  customer_name: string;
  company_name: string;
  lender_bucket: string;
  lender_canonical: number;
  due_date: string;
  dpd: number;
  computed_canonical: number;
}

/**
 * DPD cross-check (Phase 7 correction): buckets are 100% lender-supplied
 * with no independent aging calculation -- standard collection-agency
 * practice also tracks the EMI due date and computes DPD independently, to
 * catch cases where the two disagree. This NEVER overrides `customers.bucket`
 * -- the lender's bucket stays authoritative for billing/reporting; a
 * mismatch here just means "worth a second look," using the standard
 * 30-day-increment convention (0-29 days = canonical 0/current, 30-59 = 1,
 * 60-89 = 2, ...). Only customers with BOTH a due_date (the source column
 * was mapped) and a canonically-mapped lender bucket can be checked at all;
 * everyone else is silently excluded, not flagged as a false mismatch.
 */
export async function bucketMismatchReport(
  agencyId: string,
  companyId?: string,
  branchId?: string,
): Promise<{ rows: BucketMismatchRow[] }> {
  const params: unknown[] = [agencyId];
  let companyClause = "";
  if (companyId) {
    params.push(companyId);
    companyClause = `AND c.company_id = $${params.length}`;
  }
  const branchClause = branchId
    ? `AND ${reportBranchClause(branchId, params, "c", null, ["c.assigned_agent_id", "c.assigned_field_agent_id"])}`
    : "";
  const { rows } = await pool.query(
    `SELECT c.id AS customer_id, c.loan_number, c.customer_name, co.name AS company_name,
            c.bucket AS lender_bucket, b.canonical_bucket AS lender_canonical,
            c.due_date,
            GREATEST(CURRENT_DATE - c.due_date, 0)::int AS dpd,
            GREATEST(FLOOR(GREATEST(CURRENT_DATE - c.due_date, 0) / 30.0), 0)::int AS computed_canonical
       FROM customers c
       JOIN companies co ON co.id = c.company_id
       JOIN buckets b ON b.company_id = c.company_id AND lower(b.label) = lower(c.bucket)
      WHERE co.agency_id = $1 AND c.status = 'active'
        AND c.due_date IS NOT NULL AND b.canonical_bucket IS NOT NULL
        AND FLOOR(GREATEST(CURRENT_DATE - c.due_date, 0) / 30.0) <> b.canonical_bucket
        ${companyClause} ${branchClause}
      ORDER BY dpd DESC`,
    params,
  );
  return { rows: rows as BucketMismatchRow[] };
}

/** Products + buckets available under the current scope (dashboard filter options). */
export async function filterOptions(
  agencyId: string,
  companyId?: string,
): Promise<{ products: string[]; buckets: string[] }> {
  const productParams: unknown[] = [agencyId];
  let companyClause = "";
  if (companyId) {
    productParams.push(companyId);
    companyClause = `AND p.company_id = $${productParams.length}`;
  }
  const { rows: products } = await pool.query(
    `SELECT DISTINCT p.canonical_label AS label
       FROM products p JOIN companies co ON co.id = p.company_id
      WHERE co.agency_id = $1 ${companyClause}
      ORDER BY 1`,
    productParams,
  );
  const bucketParams: unknown[] = [agencyId];
  let bucketCompanyClause = "";
  if (companyId) {
    bucketParams.push(companyId);
    bucketCompanyClause = `AND b.company_id = $${bucketParams.length}`;
  }
  const { rows: buckets } = await pool.query(
    `SELECT b.label, MIN(b.sort_order) AS ord
       FROM buckets b JOIN companies co ON co.id = b.company_id
      WHERE co.agency_id = $1 ${bucketCompanyClause}
      GROUP BY b.label ORDER BY ord, b.label`,
    bucketParams,
  );
  return {
    products: products.map((r) => r.label as string),
    buckets: buckets.map((r) => r.label as string),
  };
}

export interface AgentActivityRow {
  kind: "call" | "payment" | "ptp" | "field_visit";
  id: string;
  at: string;
  agent_id: string;
  agent_name: string;
  agent_type: "telecaller" | "field_agent" | null;
  customer_id: string;
  customer_name: string;
  loan_number: string;
  customer_branch_id: string | null;
  customer_branch_name: string | null;
  customer_bucket: string | null;
  customer_company_id: string;
  customer_company_name: string;
  customer_mobile: string | null;
  customer_product: string | null;
  customer_pos: string | null;
  customer_emi: string | null;
  customer_due_amount: string | null;
  ptp_status: "pending" | "kept" | "broken" | null;
  remark: string | null;
  amount: string | null;
  detail: string | null;
}

/**
 * One or more agents' recent collections activity across ALL their
 * customers -- the gap the customer-360 trail (GET /customers/:id) and the
 * per-agent-per-day aggregate counts (/tracking/team-day) don't cover
 * between them. Access control is the caller's job (see
 * GET /reports/agent-activity, which reuses scopeFilter() the same way
 * /tracking/team-day does).
 *
 * `options.today` scopes to the current IST day (for the "Today's Work"
 * view) using the same AT TIME ZONE 'Asia/Kolkata' idiom as
 * collectedToday() -- bare `now()` would have the same UTC-boundary bug.
 * `options.dispositionCodeId` narrows to calls carrying that disposition;
 * payments/PTPs/field visits have no disposition of their own, so that
 * filter excludes those branches entirely rather than silently matching
 * nothing against them.
 */
export async function agentRecentActivity(
  agencyId: string,
  agentIds: string[],
  limit: number,
  options: {
    today?: boolean;
    date?: string; // YYYY-MM-DD, IST-boundary; if set, overrides today
    dispositionCodeId?: string;
    dispositionCodeIds?: string[];
    branchIds?: string[];
    buckets?: string[];
    companyIds?: string[];
    products?: string[];
    ptpStatuses?: ("pending" | "kept" | "broken")[];
    actionTypes?: ("call" | "payment" | "ptp" | "field_visit")[];
    search?: string;
    offset?: number;
  } = {},
): Promise<AgentActivityRow[] & { total_count?: number }> {
  if (agentIds.length === 0) return [];
  const params: unknown[] = [agentIds, agencyId];

  // Determine date boundary: explicit date param takes precedence over legacy today param
  let dateClause = "";
  if (options.date) {
    params.push(options.date);
    const dateParam = `$${params.length}`;
    dateClause = ` AND {COL} >= (${dateParam}::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND {COL} < ((${dateParam}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`;
  } else if (options.today) {
    dateClause = ` AND {COL} >= (((now() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp AT TIME ZONE 'Asia/Kolkata') AND {COL} < (((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`;
  }

  const dateFor = (col: string) => (dateClause ? dateClause.replace("{COL}", col) : "");

  // Build disposition filter (backward-compat: single dispositionCodeId or array dispositionCodeIds)
  let dispositionClause = "";
  const dispositionIds = options.dispositionCodeIds || (options.dispositionCodeId ? [options.dispositionCodeId] : []);
  if (dispositionIds.length > 0) {
    params.push(dispositionIds);
    dispositionClause = ` AND cl.disposition_code_id = ANY($${params.length}::uuid[])`;
  }

  // Build customer-level filters (apply to all branches via subquery)
  let customerFilterClause = "";
  if (options.branchIds && options.branchIds.length > 0) {
    params.push(options.branchIds);
    customerFilterClause += ` AND c.branch_id = ANY($${params.length}::uuid[])`;
  }
  if (options.buckets && options.buckets.length > 0) {
    params.push(options.buckets);
    customerFilterClause += ` AND c.bucket = ANY($${params.length}::text[])`;
  }
  if (options.companyIds && options.companyIds.length > 0) {
    params.push(options.companyIds);
    customerFilterClause += ` AND c.company_id = ANY($${params.length}::uuid[])`;
  }
  if (options.products && options.products.length > 0) {
    params.push(options.products);
    customerFilterClause += ` AND c.product = ANY($${params.length}::text[])`;
  }

  // Build search filter (apply to all branches via subquery)
  let searchClause = "";
  if (options.search) {
    const searchTerm = `%${options.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
    searchClause = ` AND (c.customer_name ILIKE $${params.length - 2} OR c.loan_number ILIKE $${params.length - 1} OR c.mobile_number ILIKE $${params.length})`;
  }

  // Determine which action types to include (controls which branches are in UNION)
  const actionTypes = options.actionTypes && options.actionTypes.length > 0
    ? options.actionTypes
    : ["call", "payment", "ptp", "field_visit"];
  const includeCall = actionTypes.includes("call");
  const includePayment = actionTypes.includes("payment");
  const includePtp = actionTypes.includes("ptp");
  const includeFieldVisit = actionTypes.includes("field_visit");

  // Build PTP status filter (only affects ptp branch)
  let ptpStatusClause = "";
  if (options.ptpStatuses && options.ptpStatuses.length > 0) {
    params.push(options.ptpStatuses);
    ptpStatusClause = ` AND pt.status = ANY($${params.length}::text[])`;
  }

  const branches: string[] = [];

  if (includeCall) {
    branches.push(
      `(SELECT 'call' AS kind, cl.id::text AS id, cl.created_at AS at, cl.agent_id,
               u.full_name AS agent_name, u.agent_type,
               c.id::text AS customer_id, c.customer_name, c.loan_number,
               c.branch_id AS customer_branch_id, b.name AS customer_branch_name,
               c.bucket AS customer_bucket, c.company_id AS customer_company_id, co.name AS customer_company_name,
               c.mobile_number AS customer_mobile, c.product AS customer_product,
               c.pos::text AS customer_pos, c.emi::text AS customer_emi, c.due_amount::text AS customer_due_amount,
               NULL, cl.remark, NULL::text AS amount, dc.action_code AS detail
          FROM call_logs cl
          JOIN users u ON u.id = cl.agent_id
          JOIN customers c ON c.id = cl.customer_id
          JOIN companies co ON co.id = c.company_id
          LEFT JOIN branches b ON b.id = c.branch_id
          LEFT JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
         WHERE cl.agent_id = ANY($1) AND co.agency_id = $2 ${dateFor("cl.created_at")} ${dispositionClause}${customerFilterClause}${searchClause})`,
    );
  }

  if (includePayment) {
    branches.push(
      `(SELECT 'payment', p.id::text, p.paid_at, p.collected_by_user_id,
               u.full_name, u.agent_type,
               c.id::text, c.customer_name, c.loan_number,
               c.branch_id, b.name, c.bucket, c.company_id, co.name,
               c.mobile_number, c.product, c.pos::text, c.emi::text, c.due_amount::text,
               NULL, NULL::text, p.amount::text, p.mode
          FROM payments p
          JOIN users u ON u.id = p.collected_by_user_id
          JOIN customers c ON c.id = p.customer_id
          JOIN companies co ON co.id = c.company_id
          LEFT JOIN branches b ON b.id = c.branch_id
         WHERE p.collected_by_user_id = ANY($1) AND co.agency_id = $2 ${dateFor("p.paid_at")}${customerFilterClause}${searchClause})`,
    );
  }

  if (includePtp) {
    branches.push(
      `(SELECT 'ptp', pt.id::text, pt.created_at, pt.agent_id,
               u.full_name, u.agent_type,
               c.id::text, c.customer_name, c.loan_number,
               c.branch_id, b.name, c.bucket, c.company_id, co.name,
               c.mobile_number, c.product, c.pos::text, c.emi::text, c.due_amount::text,
               pt.status, NULL::text, pt.amount::text, pt.promised_date::text
          FROM ptps pt
          JOIN users u ON u.id = pt.agent_id
          JOIN customers c ON c.id = pt.customer_id
          JOIN companies co ON co.id = c.company_id
          LEFT JOIN branches b ON b.id = c.branch_id
         WHERE pt.agent_id = ANY($1) AND co.agency_id = $2 ${dateFor("pt.created_at")}${customerFilterClause}${searchClause}${ptpStatusClause})`,
    );
  }

  if (includeFieldVisit) {
    branches.push(
      `(SELECT 'field_visit', fv.id::text, fv.created_at, fv.agent_id,
               u.full_name, u.agent_type,
               c.id::text, c.customer_name, c.loan_number,
               c.branch_id, b.name, c.bucket, c.company_id, co.name,
               c.mobile_number, c.product, c.pos::text, c.emi::text, c.due_amount::text,
               NULL, fv.remark, NULL::text, NULL::text
          FROM field_visits fv
          JOIN users u ON u.id = fv.agent_id
          JOIN customers c ON c.id = fv.customer_id
          JOIN companies co ON co.id = c.company_id
          LEFT JOIN branches b ON b.id = c.branch_id
         WHERE fv.agent_id = ANY($1) AND co.agency_id = $2 ${dateFor("fv.created_at")}${customerFilterClause}${searchClause})`,
    );
  }

  // If no branches are included, return empty result
  if (branches.length === 0) return [];

  const offset = options.offset || 0;
  params.push(limit, offset);
  const unionSql = branches.join(" UNION ALL ");
  const paginatedSql = `
    WITH activity_rows AS (
      ${unionSql}
    )
    SELECT *, COUNT(*) OVER() AS total_count
    FROM activity_rows
    ORDER BY at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const { rows } = await pool.query<AgentActivityRow & { total_count: number }>(paginatedSql, params);

  // Attach total_count as a property on the array (TypeScript quirk: arrays can have properties)
  const result = rows.map(r => {
    const { total_count, ...row } = r;
    return row as AgentActivityRow;
  });
  (result as any).total_count = rows.length > 0 ? rows[0].total_count : 0;

  return result;
}
