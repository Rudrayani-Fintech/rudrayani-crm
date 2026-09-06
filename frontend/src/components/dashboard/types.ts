/**
 * What survives of the old Management Dashboard's types.
 *
 * MetricBlock / MetricKey / DashboardData / METRIC_TITLES described the
 * dashboard payload and widget set that Phases 7 and 15 deleted, and became
 * unreferenced once AgentDetailDrawer stopped calling the removed
 * /reports/dashboard. Only the filter shape is still in use -- by
 * BreakdownTable and BranchDetailDrawer, which drive the Org Chart and
 * Branches drill-downs off GET /reports/breakdown.
 */
export interface DashboardFilters {
  month: string; // YYYY-MM
  company_id?: string;
  branch_id?: string;
  team_id?: string;
  agent_id?: string;
  product?: string;
  bucket?: string;
  status?: "active" | "closed" | "recalled";
}
