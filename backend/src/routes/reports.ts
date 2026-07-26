import { Router, type Request } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requireAnyPermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { capabilitiesHavePermission } from "../services/permission-service";
import { scopeFilter } from "../services/scope";
import { capabilitiesOf } from "../types/user";
import {
  agentBreakdown,
  agentRecentActivity,
  bucketMismatchReport,
  bucketMovementReport,
  collectionTrend,
  dashboard,
  depositsByRange,
  dimensionBreakdown,
  filterOptions,
  overview,
  recallReport,
  resolveReportScope,
  trailAnalytics,
  type BreakdownDimension,
  type ReportFilters,
} from "../services/report-service";

/**
 * Performance dashboard API (Phase 5). reports.view = full filterable view
 * (admin/ops agency-wide, TL team-clamped); reports.view_self = own numbers
 * only. The service clamps the scope — the client cannot widen it.
 */
const router = Router();
router.use(authenticate, requireAnyPermission("reports.view", "reports.view_self"));

const filtersSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")
    .transform((m) => `${m}-01`),
  company_id: z.string().uuid().optional(),
  branch_id: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  product: z.string().trim().min(1).max(200).optional(),
  bucket: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "closed", "recalled"]).optional(),
});

async function hasFullView(req: Request): Promise<boolean> {
  return capabilitiesHavePermission(capabilitiesOf(req.user!), "reports.view");
}

/**
 * recallReport()/bucketMovementReport()/bucketMismatchReport() took only
 * agencyId/month/companyId -- no scope at all, so a branch_manager got
 * agency-wide data from these three endpoints (RBAC gap, Phase C). Reuses
 * resolveReportScope() the same way every other report endpoint already
 * does; admin/ops get clampedTo "agency" (undefined branch_id -- no
 * narrowing), branch_manager gets clampedTo "branch". A month is required by
 * ReportFilters even though these three don't take one from the client --
 * `overview()` uses the same placeholder-month pattern for the same reason.
 */
async function scopedBranchId(req: Request, companyId?: string): Promise<string | undefined> {
  const full = await hasFullView(req);
  const scope = await resolveReportScope(
    req.user!,
    { month: "2000-01-01", company_id: companyId },
    full,
  );
  return scope.clampedTo === "branch" ? scope.filters.branch_id : undefined;
}

router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const filters = filtersSchema.parse(req.query) as ReportFilters;
    const full = await hasFullView(req);
    const result = await dashboard(req.user!, filters, full);
    const options = await filterOptions(req.user!.agency_id, filters.company_id);
    res.json({ ...result, filters: options });
  }),
);

/**
 * One agent's recent collections activity across all their customers -- no
 * agent-centric feed existed before (only per-customer trail and per-day
 * aggregate counts). Access is gated the same way /tracking/team-day already
 * gates per-agent visibility: reuse scopeFilter() (agency-wide for
 * admin/ops, own branch for branch_manager, self otherwise) rather than
 * re-deriving a new visibility rule here.
 */
router.get(
  "/agent-activity",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        agent_id: z.string().uuid().optional(),
        // "Today's Work" branch-manager drill-down: every agent under the
        // branch this caller manages, in one grouped query rather than N+1.
        scope: z.enum(["team"]).optional(),
        today: z.coerce.boolean().optional(),
        disposition_code_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(20),
      })
      .parse(req.query);

    let agentIds: string[];
    let agentNames: Map<string, string> | null = null;

    if (query.scope === "team") {
      if (req.user!.designation !== "branch_manager") {
        throw new HttpError(403, "Only a branch manager can view team activity");
      }
      const scope = await scopeFilter(req.user!);
      const clause = scope.param !== null ? scope.clause.replaceAll("$SCOPE", "$2") : "";
      const params: unknown[] = scope.param !== null ? [req.user!.agency_id, scope.param] : [req.user!.agency_id];
      const { rows } = await pool.query<{ id: string; full_name: string }>(
        `SELECT u.id, u.full_name FROM users u WHERE u.agency_id = $1 AND u.is_active = true ${clause}`,
        params,
      );
      agentIds = rows.map((r) => r.id);
      agentNames = new Map(rows.map((r) => [r.id, r.full_name]));
    } else {
      const targetAgentId = query.agent_id ?? req.user!.id;
      if (targetAgentId !== req.user!.id) {
        const scope = await scopeFilter(req.user!);
        if (scope.param !== null) {
          const clause = scope.clause.replaceAll("$SCOPE", "$2");
          const { rows } = await pool.query(
            `SELECT 1 FROM users u WHERE u.id = $1 AND u.agency_id = $3 ${clause}`,
            [targetAgentId, scope.param, req.user!.agency_id],
          );
          if (rows.length === 0) throw new HttpError(403, "You cannot view this agent's activity");
        }
      }
      agentIds = [targetAgentId];
    }

    const activity = await agentRecentActivity(req.user!.agency_id, agentIds, query.limit, {
      today: query.today,
      dispositionCodeId: query.disposition_code_id,
    });
    const withNames = agentNames
      ? activity.map((a) => ({ ...a, agent_name: agentNames!.get(a.agent_id) ?? null }))
      : activity;
    res.json({ agent_id: query.agent_id ?? null, activity: withNames });
  }),
);

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const query = filtersSchema
      .omit({ month: true })
      .extend({
        months: z
          .union([z.literal("all"), z.coerce.number().int().min(1).max(36)])
          .default(3),
      })
      .parse(req.query);
    const full = await hasFullView(req);
    const { months, ...filters } = query;
    const result = await overview(req.user!, filters, full, months);
    res.json(result);
  }),
);

router.get(
  "/agents",
  asyncHandler(async (req, res) => {
    const filters = filtersSchema.parse(req.query) as ReportFilters;
    const full = await hasFullView(req);
    const rows = await agentBreakdown(req.user!, filters, full);
    res.json({ rows });
  }),
);

const DIMENSIONS = ["company", "product", "bucket", "branch", "team", "agent"] as const;

router.get(
  "/breakdown",
  asyncHandler(async (req, res) => {
    const { dimension, ...rest } = z
      .object({ dimension: z.enum(DIMENSIONS) })
      .and(filtersSchema)
      .parse(req.query);
    const filters = rest as ReportFilters;
    const full = await hasFullView(req);
    const rows = await dimensionBreakdown(req.user!, filters, full, dimension as BreakdownDimension);
    res.json({ dimension, rows });
  }),
);

const dateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  company_id: z.string().uuid().optional(),
  branch_id: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  product: z.string().trim().min(1).max(200).optional(),
  bucket: z.string().trim().min(1).max(200).optional(),
});

/**
 * Shared scope clamp for the three free-date-range endpoints below
 * (/deposits-range, /trail, /trend). These used to hand-roll their own
 * "if full view: use filters as-is" branch, which never clamped branch_id
 * for a branch_manager (who holds reports.view, so hasFullView() is true
 * for them too) -- a branch_manager could see, or explicitly request,
 * agency-wide financial data through these three routes alone. Routing
 * through resolveReportScope() -- the same function /dashboard already
 * trusts -- clamps branch_id to the manager's own branch and 403s on an
 * explicit request for a branch they don't manage, instead of silently
 * honouring it.
 */
async function resolveDateRangeScope(
  req: Request,
  filters: Omit<ReportFilters, "month">,
): Promise<Omit<ReportFilters, "month">> {
  const full = await hasFullView(req);
  const resolved = await resolveReportScope(req.user!, { ...filters, month: "2000-01-01" }, full);
  const { month: _month, ...scope } = resolved.filters;
  return scope;
}

/** Deposits collected/deposited in a free date range (event-level, range-compatible). */
router.get(
  "/deposits-range",
  asyncHandler(async (req, res) => {
    const { from, to, ...filters } = dateRangeSchema.parse(req.query);
    const scope = await resolveDateRangeScope(req, filters);
    const result = await depositsByRange(req.user!.agency_id, from, to, scope);
    res.json(result);
  }),
);

/** Trail/disposition analytics: event-level data, so a free date range fits better than month-at-a-time. */
router.get(
  "/trail",
  asyncHandler(async (req, res) => {
    const { from, to, ...filters } = dateRangeSchema.parse(req.query);
    const scope = await resolveDateRangeScope(req, filters);
    const result = await trailAnalytics(req.user!.agency_id, from, to, scope);
    res.json(result);
  }),
);

/**
 * Recovery Trend (Management Dashboard KPI, Phase 12): daily/weekly collected
 * buckets over a free date range -- same scope clamp as /deposits-range and
 * /trail (event-level data, so a range fits better than month-at-a-time).
 */
router.get(
  "/trend",
  asyncHandler(async (req, res) => {
    const { from, to, granularity, ...filters } = dateRangeSchema
      .extend({ granularity: z.enum(["day", "week"]).default("day") })
      .parse(req.query);
    const scope = await resolveDateRangeScope(req, filters);
    const points = await collectionTrend(req.user!.agency_id, from, to, granularity, scope);
    res.json({ from, to, granularity, points });
  }),
);

router.get(
  "/recalls",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
        company_id: z.string().uuid().optional(),
      })
      .parse(req.query);
    const branchId = await scopedBranchId(req, q.company_id);
    const result = await recallReport(req.user!.agency_id, `${q.month}-01`, q.company_id, branchId);
    res.json(result);
  }),
);

router.get(
  "/bucket-movements",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
        company_id: z.string().uuid().optional(),
      })
      .parse(req.query);
    const branchId = await scopedBranchId(req, q.company_id);
    const result = await bucketMovementReport(req.user!.agency_id, `${q.month}-01`, q.company_id, branchId);
    res.json(result);
  }),
);

/** DPD cross-check: live (as-of-today), not month-scoped -- a mismatch is a right-now fact, not a historical one. */
router.get(
  "/bucket-mismatches",
  asyncHandler(async (req, res) => {
    const q = z.object({ company_id: z.string().uuid().optional() }).parse(req.query);
    const branchId = await scopedBranchId(req, q.company_id);
    const result = await bucketMismatchReport(req.user!.agency_id, q.company_id, branchId);
    res.json(result);
  }),
);

const METRIC_TITLES: Record<string, string> = {
  resolution: "Resolution",
  rollback: "Roll Back",
  normalization: "Normalization",
  recovery: "Recovery",
};

/** Everything the current filters show, as a two-sheet workbook. */
router.get(
  "/export",
  asyncHandler(async (req, res) => {
    const filters = filtersSchema.parse(req.query) as ReportFilters;
    const full = await hasFullView(req);
    const result = await dashboard(req.user!, filters, full);
    const agents = await agentBreakdown(req.user!, filters, full);

    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet("Summary");
    summary.addRow(["Performance Dashboard", result.month]);
    summary.addRow([
      "Filters",
      [
        filters.company_id && "company",
        filters.branch_id && "branch",
        filters.team_id && "team",
        filters.agent_id && "agent",
        filters.product && `product=${filters.product}`,
        filters.bucket && `bucket=${filters.bucket}`,
      ]
        .filter(Boolean)
        .join(", ") || "All (scope: " + result.scope.clamped_to + ")",
    ]);
    summary.addRow([]);
    summary.addRow(["Allocated Amount", result.allocated.amount]);
    summary.addRow(["Allocated Count", result.allocated.count]);
    summary.addRow([]);
    summary.addRow([
      "Metric",
      "Basis",
      "Allocated Amount",
      "Target Amount",
      "Target %",
      "MTD Amount",
      "MTD %",
      "MTD Count",
      "Run Rate Current",
      "Run Rate Required",
    ]);
    for (const [key, metric] of Object.entries(result.metrics)) {
      summary.addRow([
        METRIC_TITLES[key] ?? key,
        metric.basis,
        metric.allocated_amount,
        metric.target_amount,
        metric.target_pct,
        metric.mtd_amount,
        metric.mtd_pct,
        metric.mtd_count,
        metric.run_rate_current,
        metric.run_rate_required,
      ]);
    }
    summary.addRow([]);
    summary.addRow(["Collection MTD", result.collection.mtd_amount]);
    summary.addRow(["Collection Target", result.collection.target_amount]);
    summary.addRow(["Total Collected", result.deposits.collected]);
    summary.addRow(["Total Deposited", result.deposits.deposited]);
    summary.addRow(["Total Pending", result.deposits.pending]);
    summary.addRow(["Trail Uploaded", result.trail.uploaded_count]);
    summary.addRow(["Trail %", result.trail.pct]);
    summary.getColumn(1).width = 24;
    summary.getRow(7).font = { bold: true };

    const agentsSheet = wb.addWorksheet("Agents");
    agentsSheet.addRow([
      "Agent",
      "Team",
      "Allocated Amount",
      "Allocated Count",
      "Collected",
      "Resolution MTD",
      "Roll Back MTD",
      "Normalization MTD",
      "Recovery MTD",
      "Trail Count",
      "Collection Target",
      "Achievement %",
    ]);
    agentsSheet.getRow(1).font = { bold: true };
    for (const a of agents) {
      agentsSheet.addRow([
        a.full_name,
        a.team_name,
        a.allocated_amount,
        a.allocated_count,
        a.collected_amount,
        a.resolution_amount,
        a.rollback_amount,
        a.normalization_amount,
        a.recovery_amount,
        a.trail_count,
        a.target_amount,
        a.achievement_pct,
      ]);
    }
    agentsSheet.getColumn(1).width = 24;

    const breakdownDimension = z
      .enum(DIMENSIONS)
      .default("product")
      .parse(req.query.breakdown_dimension);
    const breakdownRows = await dimensionBreakdown(req.user!, filters, full, breakdownDimension);
    const breakdownSheet = wb.addWorksheet("Breakdown");
    breakdownSheet.addRow([`By ${breakdownDimension}`, "Allocated Amount", "Allocated Count", "Collected", "Resolution %", "Rollback %", "Normalization %", "Recovery %", "Trail %", "Target", "Achievement %"]);
    breakdownSheet.getRow(1).font = { bold: true };
    for (const r of breakdownRows) {
      breakdownSheet.addRow([
        r.label,
        r.allocated_amount,
        r.allocated_count,
        r.collected_amount,
        r.resolution_pct,
        r.rollback_pct,
        r.normalization_pct,
        r.recovery_pct,
        r.trail_pct,
        r.target_amount,
        r.achievement_pct,
      ]);
    }
    breakdownSheet.getColumn(1).width = 24;

    // Trail/recalls/bucket-movements are month-scoped here (the export's own
    // filters.month), even though /trail itself takes a free date range.
    const [y, m] = filters.month.split("-").map(Number);
    const monthStart = filters.month;
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const trail = await trailAnalytics(req.user!.agency_id, monthStart, monthEnd, filters);
    const trailSheet = wb.addWorksheet("Trail");
    trailSheet.addRow(["Total Trails", trail.total_trails]);
    trailSheet.addRow(["Unique Customers Contacted", trail.unique_customers_contacted]);
    trailSheet.addRow(["PTPs Created", trail.ptps_created]);
    trailSheet.addRow(["PTPs Kept", trail.ptps_kept]);
    trailSheet.addRow(["PTPs Broken", trail.ptps_broken]);
    trailSheet.addRow(["PTP Conversion %", trail.ptp_conversion_pct]);
    trailSheet.addRow([]);
    trailSheet.addRow(["Action Code", "Count"]);
    for (const r of trail.by_action_code) trailSheet.addRow([r.action_code, r.count]);
    trailSheet.addRow([]);
    trailSheet.addRow(["Result Code", "Count"]);
    for (const r of trail.by_result_code) trailSheet.addRow([r.result_code, r.count]);
    trailSheet.getColumn(1).width = 28;

    const exportBranchId = await scopedBranchId(req, filters.company_id);
    const recalls = await recallReport(req.user!.agency_id, filters.month, filters.company_id, exportBranchId);
    const recallsSheet = wb.addWorksheet("Recalls");
    recallsSheet.addRow(["Total Recalled This Month", recalls.total_recalled_count]);
    recallsSheet.addRow(["Total Recalled Amount", recalls.total_recalled_amount]);
    recallsSheet.addRow(["Lifetime Recalled Book", recalls.lifetime_recalled_count]);
    recallsSheet.addRow([]);
    recallsSheet.addRow(["Company", "Recalled Count", "Recalled Amount"]);
    recallsSheet.getRow(5).font = { bold: true };
    for (const r of recalls.by_company) {
      recallsSheet.addRow([r.company_name, r.recalled_count, r.recalled_amount]);
    }
    recallsSheet.getColumn(1).width = 24;

    const recalledCustomersSheet = wb.addWorksheet("Recalled Customers");
    recalledCustomersSheet.addRow([
      "Loan Number",
      "Customer",
      "Company",
      "Recalled At",
      "Last Bucket",
      "Last Due Amount",
      "Last Assigned Agent",
    ]);
    recalledCustomersSheet.getRow(1).font = { bold: true };
    for (const r of recalls.customers) {
      recalledCustomersSheet.addRow([
        r.loan_number,
        r.customer_name,
        r.company_name,
        r.recalled_at,
        r.last_bucket,
        r.last_due_amount,
        r.last_agent_name,
      ]);
    }
    recalledCustomersSheet.getColumn(1).width = 24;

    const movements = await bucketMovementReport(
      req.user!.agency_id,
      filters.month,
      filters.company_id,
      exportBranchId,
    );
    const movementsSheet = wb.addWorksheet("Bucket Movements");
    movementsSheet.addRow(["Company", "Bucket", "Payment-Detected", "Allocation-Confirmed", "Detected Not Confirmed"]);
    movementsSheet.getRow(1).font = { bold: true };
    for (const r of movements.rows) {
      movementsSheet.addRow([r.company_name, r.bucket, r.payment_detected, r.allocation_confirmed, r.detected_not_confirmed]);
    }
    movementsSheet.getColumn(1).width = 24;

    const mismatches = await bucketMismatchReport(req.user!.agency_id, filters.company_id, exportBranchId);
    const mismatchSheet = wb.addWorksheet("Bucket Mismatches");
    mismatchSheet.addRow([
      "Loan Number",
      "Customer",
      "Lender Bucket",
      "Lender Canonical",
      "Due Date",
      "DPD",
      "DPD-Implied Canonical",
    ]);
    mismatchSheet.getRow(1).font = { bold: true };
    for (const r of mismatches.rows) {
      mismatchSheet.addRow([
        r.loan_number,
        r.customer_name,
        r.lender_bucket,
        r.lender_canonical,
        r.due_date,
        r.dpd,
        r.computed_canonical,
      ]);
    }
    mismatchSheet.getColumn(1).width = 24;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=dashboard-${result.month}.xlsx`,
    );
    const buffer = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  }),
);

export default router;
