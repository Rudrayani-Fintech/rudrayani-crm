import { Card, Col, DatePicker, Row, Select, Space, Spin, Tag, theme, Typography, message } from "antd";
import { Column } from "@ant-design/plots";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../api/client";
import AgentDetailDrawer from "../../components/AgentDetailDrawer";
import BranchDetailDrawer from "../../components/BranchDetailDrawer";
import TeamDetailDrawer from "../../components/TeamDetailDrawer";
import BreakdownTable, { type BreakdownRow as BreakdownTableRow, type Dimension } from "../../components/dashboard/BreakdownTable";
import SummaryStat from "../../components/dashboard/SummaryStat";
import { compactCount, lakh, pctText } from "../../components/dashboard/format";
import type { DashboardData, DashboardFilters } from "../../components/dashboard/types";
import { palette } from "../../theme/tokens";
import type { Branch, Team } from "../../types";

interface TrailSummary {
  ptps_pending_value: number;
  ptps_kept: number;
  ptps_broken: number;
}

interface AgentRow {
  agent_id: string;
  full_name: string;
  team_name: string | null;
  collected_amount: number;
  target_amount: number | null;
  achievement_pct: number | null;
}

interface TrendPoint {
  bucket: string;
  amount: number;
}

/**
 * Phase 12a: Management Dashboard -- 12 KPIs, every one of them sourced from
 * an existing /reports/* endpoint (already tested, already scoped to
 * admin/ops/TL by the server). Reuse-first: no bespoke aggregation lives
 * here that report-service.ts doesn't already own.
 *
 * Placeholder-only (deferred per Phase 12 brief, tracked separately):
 * Revenue & Agency Commission, Compliance Alerts, Legal Cases Status,
 * Incentive Calculator.
 */
export default function ManagementDashboardPage() {
  const { token } = theme.useToken();
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [companyId, setCompanyId] = useState<string>();
  const [branchId, setBranchId] = useState<string>();
  const [teamId, setTeamId] = useState<string>();
  const [agentId, setAgentId] = useState<string>();
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agentOptions, setAgentOptions] = useState<{ id: string; full_name: string }[]>([]);

  const [data, setData] = useState<DashboardData | null>(null);
  const [trail, setTrail] = useState<TrailSummary | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [activeAgents, setActiveAgents] = useState<number | null>(null);
  const [activeCases, setActiveCases] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [branchDrawerId, setBranchDrawerId] = useState<string | null>(null);
  const [teamDrawer, setTeamDrawer] = useState<{ id: string; name: string } | null>(null);
  const [agentDrawer, setAgentDrawer] = useState<{ id: string; name: string } | null>(null);

  // Completes the branch -> team -> agent drill-down (already built for
  // OrgChartPage) from the Management Dashboard's own breakdown table too,
  // reusing the same three drawers -- one drill-down pattern, multiple entry
  // points, per the requirement.
  const handleBreakdownRowClick = (dimension: Dimension, row: BreakdownTableRow) => {
    if (!row.key) return;
    if (dimension === "branch") setBranchDrawerId(row.key);
    else if (dimension === "team") setTeamDrawer({ id: row.key, name: row.label });
    else if (dimension === "agent") setAgentDrawer({ id: row.key, name: row.label });
  };

  useEffect(() => {
    api.get("/companies").then((r) => setCompanies(r.data.companies)).catch(() => undefined);
    api.get("/branches").then((r) => setBranches(r.data.branches)).catch(() => undefined);
    api.get("/teams").then((r) => setTeams(r.data.teams)).catch(() => undefined);
    api
      .get("/employees")
      .then((r) =>
        setAgentOptions(
          (r.data.employees as { id: string; full_name: string; is_active: boolean; capabilities: string[] }[])
            .filter((e) => e.is_active && (e.capabilities.includes("telecaller") || e.capabilities.includes("field_agent")))
            .map((e) => ({ id: e.id, full_name: e.full_name })),
        ),
      )
      .catch(() => undefined);
  }, []);

  // A collection an agent just recorded won't otherwise appear on a
  // dashboard tab left open until a filter changes -- poll so it does.
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const filters: DashboardFilters = useMemo(
    () => ({ month: month.format("YYYY-MM"), company_id: companyId, branch_id: branchId, team_id: teamId, agent_id: agentId }),
    [month, companyId, branchId, teamId, agentId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const monthStart = month.startOf("month");
    const monthEnd = month.endOf("month");
    const isCurrentMonth = month.isSame(dayjs(), "month");
    // Trend only makes sense up to today for the current month -- a future
    // range would just be a flat line of zeros.
    const trendTo = isCurrentMonth ? dayjs() : monthEnd;

    const baseParams: Record<string, string> = { month: filters.month };
    if (companyId) baseParams.company_id = companyId;
    if (branchId) baseParams.branch_id = branchId;
    if (teamId) baseParams.team_id = teamId;
    if (agentId) baseParams.agent_id = agentId;

    const scopeParams: Record<string, string> = {
      ...(companyId ? { company_id: companyId } : {}),
      ...(branchId ? { branch_id: branchId } : {}),
      ...(teamId ? { team_id: teamId } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
    };

    Promise.all([
      api.get("/reports/dashboard", { params: baseParams }),
      api.get("/reports/trail", {
        params: { from: monthStart.format("YYYY-MM-DD"), to: monthEnd.format("YYYY-MM-DD"), ...scopeParams },
      }),
      api.get("/reports/agents", { params: baseParams }),
      api.get("/reports/trend", {
        params: { from: monthStart.format("YYYY-MM-DD"), to: trendTo.format("YYYY-MM-DD"), granularity: "day", ...scopeParams },
      }),
      api.get("/employees", { params: { is_active: "true" } }),
      api.get("/customers", { params: { status: "active", limit: 1 } }),
    ])
      .then(([dashRes, trailRes, agentsRes, trendRes, employeesRes, customersRes]) => {
        if (cancelled) return;
        setData(dashRes.data);
        setTrail(trailRes.data);
        setAgents(agentsRes.data.rows);
        setTrend(trendRes.data.points);
        setActiveAgents((employeesRes.data.employees as unknown[]).length);
        setActiveCases(customersRes.data.total as number);
      })
      .catch((err) => message.error(errorMessage(err)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters, month, companyId, branchId, teamId, agentId, refreshTick]);

  const outstandingBalance = data ? Math.max(data.collection.pos_total - data.collection.mtd_amount, 0) : null;

  const topAgents = [...agents].sort((a, b) => b.collected_amount - a.collected_amount).slice(0, 10);
  const bottomAgents = [...agents].sort((a, b) => a.collected_amount - b.collected_amount).slice(0, 10);

  const trendChartData = trend.map((p) => ({ day: p.bucket.slice(5), amount: p.amount }));

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          Management Dashboard ({month.format("MMM YYYY")})
        </Typography.Title>
        <Space wrap>
          <Select
            style={{ width: 200 }}
            title="All companies" placeholder="All companies"
            allowClear
            value={companyId}
            onChange={(v) => setCompanyId(v ?? undefined)}
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
          <DatePicker picker="month" allowClear={false} value={month} onChange={(m) => m && setMonth(m)} />
          {/* This page previously had no branch/team/agent narrowing at all
              -- every KPI here was always agency-wide regardless of what a
              caller might expect from a "Management Dashboard". The server
              still clamps a branch_manager to their own branch/teams
              (resolveReportScope) if they view this page; these selects
              just make the agency-wide drill-down actually reachable. */}
          <Select
            style={{ width: 170 }}
            title="All branches" placeholder="All branches"
            allowClear
            value={branchId}
            onChange={(v) => {
              setBranchId(v ?? undefined);
              setTeamId(undefined);
              setAgentId(undefined);
            }}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
          />
          <Select
            style={{ width: 170 }}
            title="All teams" placeholder="All teams"
            allowClear
            value={teamId}
            onChange={(v) => {
              setTeamId(v ?? undefined);
              setAgentId(undefined);
            }}
            options={teams.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Select
            style={{ width: 190 }}
            title="All agents" placeholder="All agents"
            allowClear
            showSearch
            optionFilterProp="label"
            value={agentId}
            onChange={(v) => setAgentId(v ?? undefined)}
            options={agentOptions.map((a) => ({ value: a.id, label: a.full_name }))}
          />
        </Space>
      </div>

      {loading || !data ? (
        <div style={{ display: "grid", placeItems: "center", height: 320 }}>
          <Spin size="large" />
        </div>
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
          {/* KPIs 1-6: portfolio, collection today/MTD, collection %, PTP value, broken PTP, outstanding */}
          <Row gutter={[12, 12]}>
            <Col xs={12} md={8} lg={4}>
              <SummaryStat label="Total Portfolio (POS)" value={`₹ ${lakh(data.collection.pos_total)}`} />
            </Col>
            <Col xs={12} md={8} lg={4}>
              <SummaryStat
                label="Collected Today"
                value={`₹ ${lakh(data.collection.today_amount)}`}
                sub={`MTD: ₹ ${lakh(data.collection.mtd_amount)}`}
                accent={palette.emerald}
              />
            </Col>
            <Col xs={12} md={8} lg={4}>
              <SummaryStat
                label="Collection %"
                value={pctText(data.collection.target_pct)}
                sub={data.collection.target_amount != null ? `of ₹ ${lakh(data.collection.target_amount)} target` : "no target set"}
              />
            </Col>
            <Col xs={12} md={8} lg={4}>
              <SummaryStat
                label="PTP Value (Pending)"
                value={`₹ ${lakh(trail?.ptps_pending_value ?? 0)}`}
                accent={palette.warning}
              />
            </Col>
            <Col xs={12} md={8} lg={4}>
              <SummaryStat
                label="Broken PTP Count"
                value={compactCount(trail?.ptps_broken ?? 0)}
                accent={palette.destructive}
              />
            </Col>
            <Col xs={12} md={8} lg={4}>
              <SummaryStat label="Outstanding Balance" value={`₹ ${lakh(outstandingBalance)}`} />
            </Col>
          </Row>

          {/* KPI 7: active agents/cases */}
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6}>
              <SummaryStat label="Active Agents" value={compactCount(activeAgents)} />
            </Col>
            <Col xs={12} md={6}>
              <SummaryStat label="Active Cases" value={compactCount(activeCases)} />
            </Col>
            {/* KPI 10: Settlement vs EMI */}
            <Col xs={12} md={6}>
              <SummaryStat
                label="EMI Collections"
                value={`₹ ${lakh(data.collection.by_type.emi)}`}
                sub={`Settlement: ₹ ${lakh(data.collection.by_type.settlement)}`}
              />
            </Col>
            {/* KPI 11: Field vs Telecalling */}
            <Col xs={12} md={6}>
              <SummaryStat
                label="Field Collections"
                value={`₹ ${lakh(data.collection.by_channel.field)}`}
                sub={`Telecalling: ₹ ${lakh(data.collection.by_channel.telecalling)}`}
              />
            </Col>
          </Row>

          {/* KPI 9: Recovery Trend */}
          <Card size="small" title="Recovery Trend (Daily)">
            {trendChartData.length > 0 ? (
              <Column
                data={trendChartData}
                xField="day"
                yField="amount"
                height={220}
                maxColumnWidth={22}
                style={{ radiusTopLeft: 4, radiusTopRight: 4, fill: palette.navy }}
                axis={{ x: { labelAutoRotate: true }, y: { grid: true } }}
                tooltip={{
                  title: (d: { day: string }) => d.day,
                  items: [{ field: "amount", name: "Collected", valueFormatter: (v: number) => `₹ ${lakh(v)}` }],
                }}
              />
            ) : (
              <Typography.Text type="secondary">No collections recorded in this range yet</Typography.Text>
            )}
          </Card>

          {/* KPI 8: Client-wise / Branch-wise performance -- reuses the existing breakdown table wholesale */}
          <BreakdownTable filters={filters} onRowClick={handleBreakdownRowClick} />

          {/* KPI 12: Top 10 / Bottom 10 agents */}
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={12}>
              <AgentRankCard
                title="Top 10 Agents"
                rows={topAgents}
                onSelectAgent={(a) => setAgentDrawer({ id: a.agent_id, name: a.full_name })}
              />
            </Col>
            <Col xs={24} lg={12}>
              <AgentRankCard
                title="Bottom 10 Agents"
                rows={bottomAgents}
                onSelectAgent={(a) => setAgentDrawer({ id: a.agent_id, name: a.full_name })}
              />
            </Col>
          </Row>

          {/* Placeholder-only KPIs, deferred per Phase 12 brief */}
          <Card size="small" title="Coming Soon">
            <Row gutter={[12, 12]}>
              {["Revenue & Agency Commission", "Compliance Alerts", "Legal Cases Status", "Incentive Calculator"].map(
                (label) => (
                  <Col xs={12} md={6} key={label}>
                    <div
                      style={{
                        background: token.colorFillTertiary,
                        borderRadius: 8,
                        padding: "12px 16px",
                        opacity: 0.6,
                      }}
                    >
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {label}
                      </Typography.Text>
                      <div>
                        <Tag>Not yet available</Tag>
                      </div>
                    </div>
                  </Col>
                ),
              )}
            </Row>
          </Card>
        </Space>
      )}

      <BranchDetailDrawer branchId={branchDrawerId} open={branchDrawerId !== null} onClose={() => setBranchDrawerId(null)} />
      <TeamDetailDrawer
        teamId={teamDrawer?.id ?? null}
        teamName={teamDrawer?.name}
        month={filters.month}
        open={teamDrawer !== null}
        onClose={() => setTeamDrawer(null)}
      />
      <AgentDetailDrawer
        agentId={agentDrawer?.id ?? null}
        agentName={agentDrawer?.name}
        month={filters.month}
        open={agentDrawer !== null}
        onClose={() => setAgentDrawer(null)}
      />
    </div>
  );
}

function AgentRankCard({
  title,
  rows,
  onSelectAgent,
}: {
  title: string;
  rows: AgentRow[];
  onSelectAgent: (row: AgentRow) => void;
}) {
  const { token } = theme.useToken();
  return (
    <Card size="small" title={title}>
      {rows.length === 0 ? (
        <Typography.Text type="secondary">No agent activity this month</Typography.Text>
      ) : (
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          {rows.map((a, i) => (
            <div
              key={a.agent_id}
              onClick={() => onSelectAgent(a)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "6px 8px",
                borderRadius: 6,
                cursor: "pointer",
                background: i % 2 === 0 ? token.colorFillTertiary : "transparent",
              }}
            >
              <span>
                <Typography.Text type="secondary" style={{ marginRight: 8 }}>
                  {i + 1}.
                </Typography.Text>
                {a.full_name}
                {a.team_name && (
                  <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                    ({a.team_name})
                  </Typography.Text>
                )}
              </span>
              <span className="money" style={{ fontWeight: 600 }}>
                ₹ {lakh(a.collected_amount)}
              </span>
            </div>
          ))}
        </Space>
      )}
    </Card>
  );
}
