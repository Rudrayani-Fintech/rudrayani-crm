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
  agentRecentActivity,
  depositsByRange,
  dimensionBreakdown,
  exceptionPayments,
  overview,
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
    // Helper to normalize repeatable query params into arrays
    const toArray = (val: unknown): string[] => {
      if (!val) return [];
      if (typeof val === "string") return [val];
      if (Array.isArray(val)) return val.filter(v => typeof v === "string");
      return [];
    };

    const query = z
      .object({
        agent_id: z.string().uuid().optional(),
        agent_ids: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        agent_type: z.enum(["telecaller", "field_agent"]).optional(),
        // "Today's Work" branch-manager drill-down: every agent under the
        // branch this caller manages, in one grouped query rather than N+1.
        scope: z.enum(["team"]).optional(),
        // Admin/ops "browse all agents" mode — reports.view callers can see
        // every agent they can scope to, without needing to name each one.
        browse: z.enum(["all"]).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD
        today: z.coerce.boolean().optional(),
        branch_id: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        bucket: z.union([z.string(), z.array(z.string())]).optional(),
        company_id: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        product: z.union([z.string(), z.array(z.string())]).optional(),
        disposition_code_id: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        ptp_status: z.union([z.enum(["pending", "kept", "broken"]), z.array(z.enum(["pending", "kept", "broken"]))]).optional(),
        action_type: z.union([z.enum(["call", "payment", "ptp", "field_visit"]), z.array(z.enum(["call", "payment", "ptp", "field_visit"]))]).optional(),
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(20),
        page: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);

    let agentIds: string[];
    let agentNames: Map<string, string> | null = null;

    // Multi-agent browse mode: scope=team, explicit agent_ids/agent_type, or
    // browse=all (admin/ops browsing every agent they can see with no name/type filter --
    // without this branch, such a request falls into the single-agent "else" below and
    // silently resolves to req.user's own activity instead of the whole scoped set).
    if (query.scope === "team" || query.agent_ids || query.agent_type || query.browse === "all") {
      if (query.scope === "team" && req.user!.designation !== "branch_manager") {
        throw new HttpError(403, "Only a branch manager can view team activity");
      }

      const scope = await scopeFilter(req.user!);
      const clause = scope.param !== null ? scope.clause.replaceAll("$SCOPE", "$2") : "";
      let params: unknown[] = scope.param !== null ? [req.user!.agency_id, scope.param] : [req.user!.agency_id];
      let sql = `SELECT u.id, u.full_name FROM users u WHERE u.agency_id = $1 AND u.is_active = true ${clause}`;

      // Narrow by agent_type if provided
      if (query.agent_type) {
        sql += ` AND u.agent_type = $${params.length + 1}`;
        params.push(query.agent_type);
      }

      // Narrow by explicit agent_ids if provided
      if (query.agent_ids && toArray(query.agent_ids).length > 0) {
        const ids = toArray(query.agent_ids);
        sql += ` AND u.id = ANY($${params.length + 1}::uuid[])`;
        params.push(ids);
      }

      const { rows } = await pool.query<{ id: string; full_name: string }>(sql, params);
      agentIds = rows.map((r) => r.id);
      agentNames = new Map(rows.map((r) => [r.id, r.full_name]));

      if (agentIds.length === 0) {
        return res.json({ agent_id: null, activity: [], total_count: 0 });
      }
    } else {
      // Single agent (self or specified agent_id)
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

    const offset = (query.page - 1) * query.limit;
    const activity = await agentRecentActivity(req.user!.agency_id, agentIds, query.limit, {
      date: query.date,
      today: query.today,
      dispositionCodeId: query.disposition_code_id ? toArray(query.disposition_code_id)[0] : undefined,
      dispositionCodeIds: toArray(query.disposition_code_id),
      branchIds: toArray(query.branch_id),
      buckets: toArray(query.bucket),
      companyIds: toArray(query.company_id),
      products: toArray(query.product),
      ptpStatuses: toArray(query.ptp_status) as ("pending" | "kept" | "broken")[],
      actionTypes: toArray(query.action_type) as ("call" | "payment" | "ptp" | "field_visit")[],
      search: query.search,
      offset,
    });

    const totalCount = (activity as any).total_count || 0;
    res.json({
      agent_id: query.agent_id ?? null,
      activity,
      total_count: totalCount,
      page: query.page,
      limit: query.limit,
      total_pages: Math.ceil(totalCount / query.limit),
    });
  }),
);

/**
 * Agent Daily Activity export — same filters as GET /agent-activity but streams Excel.
 * Row-count capped at 25,000 to prevent memory/timeout issues on huge datasets.
 */
router.get(
  "/agent-activity/export",
  asyncHandler(async (req, res) => {
    // Helper to normalize repeatable query params into arrays
    const toArray = (val: unknown): string[] => {
      if (!val) return [];
      if (typeof val === "string") return [val];
      if (Array.isArray(val)) return val.filter(v => typeof v === "string");
      return [];
    };

    const query = z
      .object({
        agent_id: z.string().uuid().optional(),
        agent_ids: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        agent_type: z.enum(["telecaller", "field_agent"]).optional(),
        scope: z.enum(["team"]).optional(),
        browse: z.enum(["all"]).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        today: z.coerce.boolean().optional(),
        branch_id: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        bucket: z.union([z.string(), z.array(z.string())]).optional(),
        company_id: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        product: z.union([z.string(), z.array(z.string())]).optional(),
        disposition_code_id: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
        ptp_status: z.union([z.enum(["pending", "kept", "broken"]), z.array(z.enum(["pending", "kept", "broken"]))]).optional(),
        action_type: z.union([z.enum(["call", "payment", "ptp", "field_visit"]), z.array(z.enum(["call", "payment", "ptp", "field_visit"]))]).optional(),
        search: z.string().optional(),
      })
      .parse(req.query);

    // Same agent resolution as JSON endpoint
    let agentIds: string[];

    if (query.scope === "team" || query.agent_ids || query.agent_type || query.browse === "all") {
      if (query.scope === "team" && req.user!.designation !== "branch_manager") {
        throw new HttpError(403, "Only a branch manager can view team activity");
      }

      const scope = await scopeFilter(req.user!);
      const clause = scope.param !== null ? scope.clause.replaceAll("$SCOPE", "$2") : "";
      let params: unknown[] = scope.param !== null ? [req.user!.agency_id, scope.param] : [req.user!.agency_id];
      let sql = `SELECT u.id FROM users u WHERE u.agency_id = $1 AND u.is_active = true ${clause}`;

      if (query.agent_type) {
        sql += ` AND u.agent_type = $${params.length + 1}`;
        params.push(query.agent_type);
      }

      if (query.agent_ids && toArray(query.agent_ids).length > 0) {
        const ids = toArray(query.agent_ids);
        sql += ` AND u.id = ANY($${params.length + 1}::uuid[])`;
        params.push(ids);
      }

      const { rows } = await pool.query<{ id: string }>(sql, params);
      agentIds = rows.map((r) => r.id);

      if (agentIds.length === 0) {
        return res.json({ total_count: 0, activity: [] });
      }
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

    // Fetch activity data (no pagination for export). Cap the fetch itself at
    // ROW_LIMIT so an oversized result never costs more than one bounded query --
    // agentRecentActivity's COUNT(*) OVER() tells us the true total (respecting
    // every filter below) whether or not it exceeds the cap, so a second,
    // separately-built COUNT query (which previously ignored disposition/branch/
    // bucket/company/product/ptpStatus/actionType/search and could disagree with
    // what's actually exported) is unnecessary.
    const ROW_LIMIT = 25000;
    const activity = await agentRecentActivity(req.user!.agency_id, agentIds, ROW_LIMIT, {
      date: query.date,
      today: query.today,
      dispositionCodeIds: toArray(query.disposition_code_id),
      branchIds: toArray(query.branch_id),
      buckets: toArray(query.bucket),
      companyIds: toArray(query.company_id),
      products: toArray(query.product),
      ptpStatuses: toArray(query.ptp_status) as ("pending" | "kept" | "broken")[],
      actionTypes: toArray(query.action_type) as ("call" | "payment" | "ptp" | "field_visit")[],
      search: query.search,
    });

    const rowCount = (activity as any).total_count ?? activity.length;
    if (rowCount > ROW_LIMIT) {
      return res.status(400).json({
        error: `Too many rows (${rowCount.toLocaleString()}) for one export — narrow your filters (date, branch, bucket, or agent) and try again.`,
        row_count: rowCount,
        limit: ROW_LIMIT,
      });
    }

    // Build Excel workbook
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Agent Activity");
    sheet.addRow([
      "Date",
      "Time",
      "Agent Name",
      "Agent Type",
      "Action Type",
      "Customer Name",
      "Mobile Number",
      "Loan Number",
      "Company",
      "Product",
      "Branch",
      "Bucket",
      "Outstanding (POS)",
      "EMI",
      "Due Amount",
      "Amount",
      "Disposition Code",
      "Disposition Description",
      "PTP Status",
      "Remark",
    ]);
    sheet.getRow(1).font = { bold: true };

    // Mapping for action types and PTP status for display
    const actionTypeLabel = {
      call: "Call",
      payment: "Payment",
      ptp: "PTP",
      field_visit: "Field Visit",
    };
    const ptpStatusLabel = {
      pending: "Pending",
      kept: "Kept",
      broken: "Broken",
    };

    for (const row of activity) {
      const timestamp = new Date(row.at);
      const date = timestamp.toISOString().split("T")[0];
      const time = timestamp.toLocaleTimeString("en-IN", { hour12: false });

      sheet.addRow([
        date,
        time,
        row.agent_name,
        row.agent_type ? (row.agent_type === "telecaller" ? "Telecaller" : "Field Agent") : "",
        actionTypeLabel[row.kind as keyof typeof actionTypeLabel],
        row.customer_name,
        row.customer_mobile || "",
        row.loan_number,
        row.customer_company_name,
        row.customer_product || "",
        row.customer_branch_name || "",
        row.customer_bucket || "",
        row.customer_pos || "",
        row.customer_emi || "",
        row.customer_due_amount || "",
        row.amount || "",
        row.kind === "call" ? row.detail || "" : "",
        row.kind === "call" ? row.disposition_description || "" : "",
        row.ptp_status ? ptpStatusLabel[row.ptp_status as keyof typeof ptpStatusLabel] : "",
        row.remark || "",
      ]);
    }

    // Set column widths
    sheet.columns.forEach((col, idx) => {
      col.width = [10, 10, 18, 12, 15, 20, 15, 15, 20, 15, 15, 15, 15, 12, 15, 12, 18, 20, 12, 25][idx] || 12;
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=agent-activity-${new Date().toISOString().split("T")[0]}.xlsx`,
    );

    await wb.xlsx.write(res);
    if (!res.writableEnded) res.end();
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

/**
 * Allocated-vs-collected performance pivoted by one dimension, scope-clamped
 * the same way every other report is.
 *
 * Restored after an audit found the Org Chart's branch/team/agent drill-downs
 * and the Branches page drawer had been 404ing since Phase 7 deleted this
 * route: BreakdownTable.tsx and AgentDetailDrawer.tsx were never in that
 * phase's file list and kept calling it, so a manager clicking any node got a
 * blank drawer and a "Not found" toast. Only the HTTP route was ever deleted
 * -- dimensionBreakdown() itself stayed live and is already reused by
 * GET /employees/org-hierarchy?with_performance=true, so this is a thin
 * re-exposure of a proven aggregate, not a reimplementation. Its columns
 * (allocated, resolution/rollback/normalization/recovery %, target,
 * achievement) are genuinely not derivable from the row-level
 * /reports/agent-activity or /reports/trail feeds.
 */
router.get(
  "/breakdown",
  asyncHandler(async (req, res) => {
    const query = filtersSchema
      .extend({
        dimension: z
          .enum(["company", "product", "bucket", "branch", "team", "agent"])
          .default("product"),
      })
      .parse(req.query);
    const { dimension, ...filters } = query;
    const full = await hasFullView(req);
    const rows = await dimensionBreakdown(
      req.user!,
      filters,
      full,
      dimension as BreakdownDimension,
    );
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
 * Shared scope clamp for the free-date-range endpoints below
 * (/deposits-range, /exceptions, /trail, /trend). These used to hand-roll their own
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

/** Payments recorded above the customer's due amount -- a spot-check list, not a total. */
router.get(
  "/exceptions",
  asyncHandler(async (req, res) => {
    const { from, to, ...filters } = dateRangeSchema.parse(req.query);
    const scope = await resolveDateRangeScope(req, filters);
    const rows = await exceptionPayments(req.user!.agency_id, from, to, scope);
    res.json({ rows });
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


export default router;
