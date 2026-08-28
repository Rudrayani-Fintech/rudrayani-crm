import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { agentBranchClamp, resolveBranchClamp } from "../services/scope";
import { istMonthStart } from "../utils/ist";

/**
 * The agent's worklist — "Today's Allocation" (build brief Section 8): every
 * active customer currently assigned to the logged-in user, with the last
 * disposition and any pending PTP so the agent knows where each case stands.
 */
const router = Router();
router.use(authenticate, requirePermission("calls.log"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const companyId = req.query.company_id as string | undefined;
    const customerBranchParam = req.query.customer_branch as string | undefined;
    const product = req.query.product as string | undefined;
    const bucketParam = req.query.bucket as string | undefined;
    const scope = req.query.scope as string | undefined;

    const params: unknown[] = [req.user!.id];
    let conditions: string;

    // `scope=team` only ever applies to a branch_manager -- callers must
    // fall back to self-scope otherwise, never to "everyone". Uses the same
    // resolveBranchClamp()/agentBranchClamp() helpers as customers.ts/
    // allocations.ts/employees.ts (added in the RBAC branch-scoping batch)
    // instead of a separate, ad hoc branch_id/team_id match -- the old
    // local version missed the telecaller_branches junction table, so a
    // branch_manager who ALSO carries collections work (agent_type set)
    // never saw customers allocated directly to themself in the Team tab,
    // since their own users.branch_id/team_id are both null (their branch
    // link lives only in telecaller_branches).
    const wantsTeamScope = scope === "team" && req.user!.designation === "branch_manager";
    const clamp = wantsTeamScope ? await resolveBranchClamp(req.user!) : null;

    if (clamp) {
      const agentMatch = agentBranchClamp(clamp, params, "u").replace(/^ AND /, "");
      const fieldAgentMatch = agentBranchClamp(clamp, params, "u").replace(/^ AND /, "");
      conditions = `(
          EXISTS (SELECT 1 FROM users u WHERE u.id = c.assigned_agent_id AND ${agentMatch})
          OR EXISTS (SELECT 1 FROM users u WHERE u.id = c.assigned_field_agent_id AND ${fieldAgentMatch})
        ) AND c.status = 'active'`;
    } else {
      conditions = `(c.assigned_agent_id = $1 OR c.assigned_field_agent_id = $1) AND c.status = 'active'`;
    }

    if (q) {
      params.push(q);
      conditions += ` AND (c.customer_name ILIKE '%' || $${params.length} || '%' OR c.loan_number ILIKE '%' || $${params.length} || '%')`;
    }
    if (companyId) {
      params.push(companyId);
      conditions += ` AND c.company_id = $${params.length}`;
    }
    if (customerBranchParam) {
      const values = customerBranchParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (values.length > 0) {
        params.push(values);
        const n = params.length;
        // Case-insensitive but otherwise exact copy of `values`, for the
        // custom_fields freetext fallback below -- lowercased once here
        // rather than wrapping lower() around every array element inline.
        params.push(values.map((v) => v.toLowerCase()));
        const nLower = params.length;
        // Matches on branch_id (legacy callers still pass the branch UUID,
        // e.g. CustomersPage.tsx/AllocationPage.tsx via /customers/branches'
        // {value: id}) OR on the branch's name via the `b` alias joined
        // below (GET /worklist/filter-options below returns bare branch
        // *names*, not ids, so a name must also match directly here) OR,
        // for legacy imported rows with no branch_id at all, the raw
        // custom_fields branch text. The custom_fields leg used to be
        // `ILIKE ANY($n)`, which treats each value as a LIKE pattern --
        // a branch name containing a literal `_` or `%` (both valid in
        // freetext) would over-match. Values here come from an exact-value
        // picker (this endpoint's own /filter-options), never free-typed
        // search, so a case-insensitive exact `lower() = ANY(...)` compare
        // is both correct and safe.
        conditions += ` AND (c.branch_id::text = ANY($${n}) OR b.name = ANY($${n}) OR (c.branch_id IS NULL AND (lower(c.custom_fields->>'branch') = ANY($${nLower}) OR lower(c.custom_fields->>'Branch') = ANY($${nLower}))))`;
      }
    }
    if (product) {
      params.push(product);
      conditions += ` AND c.product = $${params.length}`;
    }
    if (bucketParam) {
      const values = bucketParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (values.length > 0) {
        params.push(values);
        conditions += ` AND c.bucket = ANY($${params.length})`;
      }
    }

    // Bare `date_trunc('month', now())` resolves in the DB session's UTC
    // clock, misclassifying "this month" for the first ~5.5h of every IST
    // day. Bind the IST month start explicitly instead.
    params.push(istMonthStart());
    const monthParam = params.length;

    const { rows } = await pool.query(
      `SELECT c.id, c.loan_number, c.customer_name, c.mobile_number,
              c.product, c.bucket, c.due_amount, c.pos, c.emi, c.custom_fields,
              c.next_action_date, c.dpd,
              co.name AS company_name,
              COALESCE(b.name, NULLIF(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')), '')) AS branch_name,
              (c.assigned_agent_id = $1) AS is_primary_for_me,
              (c.assigned_field_agent_id = $1) AS is_field_agent_for_me,
              ag.full_name AS assigned_agent_name,
              fa.full_name AS assigned_field_agent_name,
              lc.remark AS last_remark,
              lc.created_at AS last_call_at,
              ld.result_code AS last_result_code,
              pp.amount AS ptp_amount,
              pp.promised_date AS ptp_date,
              bm.normalized_pending
         FROM customers c
         JOIN companies co ON co.id = c.company_id
         LEFT JOIN branches b ON b.id = c.branch_id
         LEFT JOIN users ag ON ag.id = c.assigned_agent_id
         LEFT JOIN users fa ON fa.id = c.assigned_field_agent_id
         LEFT JOIN LATERAL (
              SELECT cl.remark, cl.created_at, cl.disposition_code_id
                FROM call_logs cl
               WHERE cl.customer_id = c.id
               ORDER BY cl.created_at DESC LIMIT 1
         ) lc ON true
         LEFT JOIN disposition_codes ld ON ld.id = lc.disposition_code_id
         LEFT JOIN LATERAL (
              SELECT p.amount, p.promised_date
                FROM ptps p
               WHERE p.customer_id = c.id AND p.status = 'pending'
               ORDER BY p.promised_date ASC LIMIT 1
         ) pp ON true
         LEFT JOIN LATERAL (
              SELECT EXISTS(
                SELECT 1 FROM bucket_movements m
                 WHERE m.customer_id = c.id AND m.trigger = 'payment'
                   AND m.month = $${monthParam}::date
              ) AS normalized_pending
         ) bm ON true
        WHERE ${conditions}
        ORDER BY c.next_action_date ASC NULLS LAST, c.due_amount DESC NULLS LAST`,
      params,
    );
    res.json({ customers: rows, total: rows.length });
  }),
);

/**
 * Branch/bucket dropdown options for the worklist filter (Track: agent
 * branch/bucket filtering) -- scoped to the requesting agent's own
 * currently-allocated active customers (or, with scope=team, everyone a
 * branch_manager manages), not the agency-wide GET /customers/branches or
 * GET /buckets lists. Mirrors the exact scope block the list route above
 * uses, so the options offered here always match what that same query would
 * actually return.
 */
router.get(
  "/filter-options",
  asyncHandler(async (req, res) => {
    const scope = req.query.scope as string | undefined;
    const wantsTeamScope = scope === "team" && req.user!.designation === "branch_manager";
    const clamp = wantsTeamScope ? await resolveBranchClamp(req.user!) : null;

    const params: unknown[] = [];
    let conditions: string;
    if (clamp) {
      const agentMatch = agentBranchClamp(clamp, params, "u").replace(/^ AND /, "");
      const fieldAgentMatch = agentBranchClamp(clamp, params, "u").replace(/^ AND /, "");
      conditions = `(
          EXISTS (SELECT 1 FROM users u WHERE u.id = c.assigned_agent_id AND ${agentMatch})
          OR EXISTS (SELECT 1 FROM users u WHERE u.id = c.assigned_field_agent_id AND ${fieldAgentMatch})
        ) AND c.status = 'active'`;
    } else {
      params.push(req.user!.id);
      conditions = `(c.assigned_agent_id = $${params.length} OR c.assigned_field_agent_id = $${params.length}) AND c.status = 'active'`;
    }

    const { rows } = await pool.query<{ branch: string | null; bucket: string | null }>(
      `SELECT DISTINCT
              COALESCE(b.name, NULLIF(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')), '')) AS branch,
              c.bucket
         FROM customers c
         LEFT JOIN branches b ON b.id = c.branch_id
        WHERE ${conditions}`,
      params,
    );
    const branches = Array.from(new Set(rows.map((r) => r.branch).filter((v): v is string => !!v))).sort();
    const buckets = Array.from(new Set(rows.map((r) => r.bucket).filter((v): v is string => !!v))).sort();
    res.json({ branches, buckets });
  }),
);

/**
 * Single customer, same shape as the list above — backs the mobile app's
 * customer-detail and its child screens (call log / payment / PTPs / field
 * visit), which resolve the customer by id on each screen load instead of
 * carrying the object across navigation (go_router's `extra` doesn't survive
 * an app restart or a cold deep link). 404 rather than 403 if the customer
 * isn't assigned to the caller, so the scope check doesn't leak whether an
 * out-of-scope loan number exists.
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    const { rows } = await pool.query(
      `SELECT c.id, c.loan_number, c.customer_name, c.mobile_number,
              c.product, c.bucket, c.due_amount, c.pos, c.emi, c.custom_fields,
              c.next_action_date, c.dpd,
              co.name AS company_name,
              COALESCE(b.name, NULLIF(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')), '')) AS branch_name,
              (c.assigned_agent_id = $1) AS is_primary_for_me,
              (c.assigned_field_agent_id = $1) AS is_field_agent_for_me,
              lc.remark AS last_remark,
              lc.created_at AS last_call_at,
              ld.result_code AS last_result_code,
              pp.amount AS ptp_amount,
              pp.promised_date AS ptp_date,
              bm.normalized_pending
         FROM customers c
         JOIN companies co ON co.id = c.company_id
         LEFT JOIN branches b ON b.id = c.branch_id
         LEFT JOIN LATERAL (
              SELECT cl.remark, cl.created_at, cl.disposition_code_id
                FROM call_logs cl
               WHERE cl.customer_id = c.id
               ORDER BY cl.created_at DESC LIMIT 1
         ) lc ON true
         LEFT JOIN disposition_codes ld ON ld.id = lc.disposition_code_id
         LEFT JOIN LATERAL (
              SELECT p.amount, p.promised_date
                FROM ptps p
               WHERE p.customer_id = c.id AND p.status = 'pending'
               ORDER BY p.promised_date ASC LIMIT 1
         ) pp ON true
         LEFT JOIN LATERAL (
              SELECT EXISTS(
                SELECT 1 FROM bucket_movements m
                 WHERE m.customer_id = c.id AND m.trigger = 'payment'
                   AND m.month = $3::date
              ) AS normalized_pending
         ) bm ON true
        WHERE c.id = $2
          AND (c.assigned_agent_id = $1 OR c.assigned_field_agent_id = $1)
          AND c.status = 'active'`,
      [req.user!.id, id, istMonthStart()],
    );
    const customer = rows[0];
    if (!customer) throw new HttpError(404, "Customer not found");
    res.json({ customer });
  }),
);

export default router;
