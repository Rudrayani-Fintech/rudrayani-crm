import {
  Button,
  DatePicker,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { DownloadOutlined, SettingOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import AgentDetailDrawer from "../components/AgentDetailDrawer";
import BranchDetailDrawer from "../components/BranchDetailDrawer";
import TeamDetailDrawer from "../components/TeamDetailDrawer";
import DashboardCustomizer from "../components/dashboard/DashboardCustomizer";
import PendingApprovalsAlert from "../components/dashboard/PendingApprovalsAlert";
import SetupChecklist from "../components/dashboard/SetupChecklist";
import { applyLayout, type DashboardRenderCtx } from "../components/dashboard/widgetRegistry";
import { useDashboardPreferences } from "../hooks/useDashboardPreferences";
import { useWorkScope } from "../scope/WorkScopeContext";
import {
  type DashboardData,
  type DashboardFilters,
  type MetricKey,
} from "../components/dashboard/types";
import type { Branch, Team } from "../types";

const ALL = "__all__";

/**
 * Performance dashboard (Phase 5, per the blueprint in "web dashboard view"):
 * product tabs, granular filters, Amount/Count toggle, metric gauge + cards,
 * deposited/trail cards, monthly overview chart, filtered Excel export.
 * The same page serves every role — the server clamps the scope (admin/ops
 * agency-wide, TL own team, agents self-only with filters hidden).
 */
export default function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const isManager = hasPermission("reports.view");

  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [companyId, setCompanyId] = useState<string>();
  const [branchId, setBranchId] = useState<string>();
  const [teamId, setTeamId] = useState<string>();
  const [agentId, setAgentId] = useState<string>();
  const [product, setProduct] = useState<string>();
  const [bucket, setBucket] = useState<string>();
  const [status, setStatus] = useState<"active" | "closed" | "recalled">();
  const [amountMode, setAmountMode] = useState(true);
  const [activeMetric, setActiveMetric] = useState<MetricKey>("resolution");

  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<{ id: string; full_name: string }[]>([]);

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  // Lifted to an app-level context (see AppLayout's header switch) so this
  // page, MyWorklistPage's list scope, and its Today section all share one
  // "My Team ↔ My Work" preference instead of three independent controls.
  const { myWorkOnly: myWork } = useWorkScope();
  const [myTeamDrawer, setMyTeamDrawer] = useState<{ id: string; name: string } | null>(null);
  const [myBranchId, setMyBranchId] = useState<string | null>(null);
  const [myAgentDrawer, setMyAgentDrawer] = useState(false);

  // A branch_manager may ALSO carry collections work (agent_type set) --
  // "additional responsibilities, the core work remains the same." The
  // header's My Team/My Work switch (AppLayout.tsx) lets them flip between
  // their management view (branch aggregate) and their own personal
  // worklist numbers, mirroring the original brief's ask.
  const isBranchManager = !!user?.capabilities.includes("branch_manager");
  const myBranch = useMemo(() => branches.find((b) => b.branch_manager_id === user?.id), [branches, user]);
  // Every team in the branch_manager's own branch, for the team drill-down
  // below -- no team_leader intermediary since Phase 2, branch_manager owns
  // every team in their branch directly.
  const myBranchTeams = useMemo(
    () => (myBranch ? teams.filter((t) => t.branch_id === myBranch.id) : []),
    [teams, myBranch],
  );

  const prefs = useDashboardPreferences();

  useEffect(() => {
    if (!isManager) return;
    api.get("/companies").then((r) => setCompanies(r.data.companies)).catch((err) => message.error(errorMessage(err)));
    api.get("/branches").then((r) => setBranches(r.data.branches)).catch((err) => message.error(errorMessage(err)));
    api.get("/teams").then((r) => setTeams(r.data.teams)).catch((err) => message.error(errorMessage(err)));
    if (hasPermission("employees.view")) {
      api.get("/employees").then((r) =>
        setAgents(
          // Anyone whose capabilities include telecaller/field_agent -- this
          // already covers plain agents AND branch_manager rows with
          // agent_type set, since capabilitiesOf() derives both from
          // the same booleans (see backend/src/types/user.ts).
          r.data.employees.filter(
            (e: { is_active: boolean; capabilities: string[] }) =>
              e.is_active && (e.capabilities.includes("telecaller") || e.capabilities.includes("field_agent")),
          ),
        ),
      ).catch((err) => message.error(errorMessage(err)));
    }
  }, [isManager, hasPermission]);

  const filters: DashboardFilters = useMemo(
    () => ({
      month: month.format("YYYY-MM"),
      company_id: companyId,
      branch_id: myWork ? undefined : branchId,
      team_id: myWork ? undefined : teamId,
      agent_id: myWork ? user?.id : agentId,
      product,
      bucket,
      status,
    }),
    [month, companyId, branchId, teamId, agentId, product, bucket, status, myWork, user],
  );

  // Guards against rapid filter changes painting stale numbers: if the
  // agent/team/branch selects change quickly, an earlier, slower request
  // can resolve AFTER a newer one and overwrite fresh data with stale data.
  // Only the response from the most recently issued load() is applied.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const params: Record<string, string> = { month: filters.month };
      for (const key of ["company_id", "branch_id", "team_id", "agent_id", "product", "bucket", "status"] as const) {
        if (filters[key]) params[key] = filters[key]!;
      }
      const res = await api.get("/reports/dashboard", { params });
      if (seq !== loadSeq.current) return;
      setData(res.data);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      message.error(errorMessage(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  // A collection an agent just recorded won't otherwise appear on a
  // dashboard tab left open until a filter changes -- poll so it does.
  // Kept in a separate, dependency-free effect so the poll timer itself
  // isn't torn down and restarted on every filter change (it previously
  // was, since `load`'s identity changes with `filters`) -- the ref always
  // points at the latest load(), so each tick still uses current filters.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    const interval = setInterval(() => void loadRef.current(), 60_000);
    return () => clearInterval(interval);
  }, []);

  const exportExcel = async () => {
    setExporting(true);
    try {
      const params: Record<string, string> = { month: filters.month };
      for (const key of ["company_id", "branch_id", "team_id", "agent_id", "product", "bucket", "status"] as const) {
        if (filters[key]) params[key] = filters[key]!;
      }
      const res = await api.get("/reports/export", { params, responseType: "blob" });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dashboard-${filters.month}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const products = data?.filters.products ?? [];
  const buckets = data?.filters.buckets ?? [];

  return (
    <div>
      <style>{`
        @media (max-width: 900px) {
          .dashboard-widget-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {hasPermission("companies.manage") && <SetupChecklist />}
      {hasPermission("customers.allocate") && <PendingApprovalsAlert />}

      {/* Product tabs (blueprint top row) */}
      <Tabs
        activeKey={product ?? ALL}
        onChange={(k) => setProduct(k === ALL ? undefined : k)}
        items={[
          { key: ALL, label: "All Products" },
          ...products.map((p) => ({ key: p, label: p })),
        ]}
      />

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
          {isManager ? "Performance Dashboard" : `My Performance — ${user?.full_name}`} (
          {month.format("MMM YYYY")})
        </Typography.Title>
        <Space wrap>
          {data && (
            <Tag color={data.days.left > 0 ? "green" : "default"} style={{ fontWeight: 600 }}>
              {data.days.left} Days Left
            </Tag>
          )}
          <Space size={6}>
            <Typography.Text type="secondary">Count</Typography.Text>
            <Switch checked={amountMode} onChange={setAmountMode} />
            <Typography.Text type="secondary">Amount</Typography.Text>
          </Space>
          {isBranchManager && myBranch && (
            <Button onClick={() => setMyBranchId(myBranch.id)}>My Branch</Button>
          )}
          {isBranchManager && myBranchTeams.length === 1 && (
            <Button onClick={() => setMyTeamDrawer({ id: myBranchTeams[0].id, name: myBranchTeams[0].name })}>
              My Team
            </Button>
          )}
          {isBranchManager && myBranchTeams.length > 1 && (
            <Select
              style={{ width: 160 }}
              title="My Teams" placeholder="My Teams"
              value={undefined}
              onChange={(id) => {
                const t = myBranchTeams.find((mt) => mt.id === id);
                if (t) setMyTeamDrawer({ id: t.id, name: t.name });
              }}
              options={myBranchTeams.map((t) => ({ value: t.id, label: t.name }))}
            />
          )}
          {!isManager && (
            <Button onClick={() => setMyAgentDrawer(true)}>My Recent Activity</Button>
          )}
          <Button icon={<DownloadOutlined />} loading={exporting} onClick={exportExcel}>
            Export
          </Button>
          <Button icon={<SettingOutlined />} onClick={() => setCustomizerOpen(true)}>
            Customize
          </Button>
        </Space>
      </div>

      {/* Filter bar — Company first, then month, then scope narrowers */}
      <Space wrap style={{ marginBottom: 16 }}>
        {isManager && (
          <Select
            style={{ width: 200 }}
            title="All companies" placeholder="All companies"
            allowClear
            value={companyId}
            onChange={(v) => setCompanyId(v ?? undefined)}
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
        )}
        <DatePicker
          picker="month"
          allowClear={false}
          value={month}
          onChange={(m) => m && setMonth(m)}
        />
        <Select
          style={{ width: 170 }}
          title="All Buckets" placeholder="All Buckets"
          allowClear
          value={bucket}
          onChange={setBucket}
          options={buckets.map((b) => ({ value: b, label: b }))}
        />
        <Select
          style={{ width: 150 }}
          title="All Statuses" placeholder="All Statuses"
          allowClear
          value={status}
          onChange={(v) => setStatus(v ?? undefined)}
          options={[
            { value: "active", label: "Active" },
            { value: "recalled", label: "Recalled" },
            { value: "closed", label: "Closed" },
          ]}
        />
        {isManager && (
          <>
            {data?.scope.clamped_to === "agency" && (
              <>
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
              </>
            )}
            {data?.scope.clamped_to === "branch" && (
              <>
                {/* The server clamps to this branch regardless of what's sent
                    (or not sent) here -- shown as fixed context, not a filter,
                    since a branch_manager can't widen past their own branch. */}
                <Tag>{myBranch?.name ?? "Your branch"}</Tag>
                <Select
                  style={{ width: 170 }}
                  title="All teams" placeholder="All teams"
                  allowClear
                  value={teamId}
                  onChange={(v) => {
                    setTeamId(v ?? undefined);
                    setAgentId(undefined);
                  }}
                  options={myBranchTeams.map((t) => ({ value: t.id, label: t.name }))}
                />
              </>
            )}
            <Select
              style={{ width: 190 }}
              title="All agents" placeholder="All agents"
              allowClear
              showSearch
              optionFilterProp="label"
              value={agentId}
              onChange={(v) => setAgentId(v ?? undefined)}
              options={agents.map((a) => ({ value: a.id, label: a.full_name }))}
            />
          </>
        )}
      </Space>

      {loading || !data ? (
        <div style={{ display: "grid", placeItems: "center", height: 320 }}>
          <Spin size="large" />
        </div>
      ) : (
        // Previously every widget rendered full-width in a single vertical
        // Space, regardless of how small its own content was -- a 3-stat
        // "Deposits" card took the same full row as the breakdown table.
        // Widgets opt into full width via fullWidth; everything else pairs
        // up two-to-a-row on wide screens and stacks on narrow ones.
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 16,
          }}
          className="dashboard-widget-grid"
        >
          {(() => {
            const ctx: DashboardRenderCtx = { data, filters, amountMode, activeMetric, setActiveMetric };
            return applyLayout(prefs.layout, isManager).map((w) => (
              <div key={w.id} style={w.fullWidth ? { gridColumn: "1 / -1" } : undefined}>
                {w.render(ctx)}
              </div>
            ));
          })()}
        </div>
      )}

      <DashboardCustomizer
        open={customizerOpen}
        onClose={() => setCustomizerOpen(false)}
        layout={prefs.layout}
        isManager={isManager}
        onSave={prefs.save}
        onReset={prefs.reset}
      />

      <TeamDetailDrawer
        teamId={myTeamDrawer?.id ?? null}
        teamName={myTeamDrawer?.name}
        month={filters.month}
        open={myTeamDrawer !== null}
        onClose={() => setMyTeamDrawer(null)}
      />
      <BranchDetailDrawer branchId={myBranchId} open={myBranchId !== null} onClose={() => setMyBranchId(null)} />
      {user && (
        <AgentDetailDrawer
          agentId={user.id}
          agentName={user.full_name}
          month={filters.month}
          open={myAgentDrawer}
          onClose={() => setMyAgentDrawer(false)}
        />
      )}
    </div>
  );
}
