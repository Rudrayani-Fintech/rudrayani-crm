import { Button, Col, DatePicker, Row, Select, Space, Typography, message } from "antd";
import { DownloadOutlined, PrinterOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import BreakdownTable, { type BreakdownRow, type Dimension } from "../components/dashboard/BreakdownTable";
import ExceptionPaymentsCard from "../components/dashboard/ExceptionPaymentsCard";
import TrailAnalyticsCard from "../components/dashboard/TrailAnalyticsCard";
import type { DashboardFilters } from "../components/dashboard/types";
import { downloadCsv } from "../utils/csv";
import type { Branch, Team } from "../types";

/**
 * The 12 working /reports/* endpoints previously had no dedicated home --
 * the breakdown engine (BreakdownTable) was buried as one card inside the
 * scrollable, month-locked Dashboard, non-exportable, non-shareable. This
 * page: a free dimension selector, an exportable table, and URL-synced
 * filters so a report can be bookmarked or handed to a colleague.
 *
 * Deliberately NOT included here (deferred, each a separate feature):
 * saved report definitions (needs its own persistence + management UI),
 * and Deposits (already has a dedicated page at /deposits).
 */
export default function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [month, setMonth] = useState<Dayjs>(() => {
    const m = searchParams.get("month");
    return m && /^\d{4}-\d{2}$/.test(m) ? dayjs(`${m}-01`) : dayjs();
  });
  const [companyId, setCompanyId] = useState<string | undefined>(() => searchParams.get("company_id") ?? undefined);
  const [branchId, setBranchId] = useState<string | undefined>(() => searchParams.get("branch_id") ?? undefined);
  const [teamId, setTeamId] = useState<string | undefined>(() => searchParams.get("team_id") ?? undefined);
  const [agentId, setAgentId] = useState<string | undefined>(() => searchParams.get("agent_id") ?? undefined);
  const [product, setProduct] = useState<string | undefined>(() => searchParams.get("product") ?? undefined);
  const [bucket, setBucket] = useState<string | undefined>(() => searchParams.get("bucket") ?? undefined);

  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agentOptions, setAgentOptions] = useState<{ id: string; full_name: string }[]>([]);
  const [products, setProducts] = useState<{ raw_label: string; canonical_label: string }[]>([]);
  const [buckets, setBuckets] = useState<string[]>([]);

  const [breakdownRows, setBreakdownRows] = useState<BreakdownRow[]>([]);
  const [breakdownDimension, setBreakdownDimension] = useState<Dimension>("product");

  useEffect(() => {
    api.get("/companies").then((r) => setCompanies(r.data.companies)).catch((err) => message.error(errorMessage(err)));
    api.get("/branches").then((r) => setBranches(r.data.branches)).catch((err) => message.error(errorMessage(err)));
    api.get("/teams").then((r) => setTeams(r.data.teams)).catch((err) => message.error(errorMessage(err)));
    api
      .get("/employees")
      .then((r) =>
        setAgentOptions(
          (r.data.employees as { id: string; full_name: string; is_active: boolean; capabilities: string[] }[])
            .filter((e) => e.is_active && (e.capabilities.includes("telecaller") || e.capabilities.includes("field_agent")))
            .map((e) => ({ id: e.id, full_name: e.full_name })),
        ),
      )
      .catch((err) => message.error(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!companyId) {
      setProducts([]);
      setBuckets([]);
      return;
    }
    Promise.all([
      api.get("/products", { params: { company_id: companyId } }),
      api.get("/buckets", { params: { company_id: companyId } }),
    ])
      .then(([p, b]) => {
        setProducts(p.data.products);
        setBuckets(b.data.buckets.map((x: { label: string }) => x.label));
      })
      .catch((err) => message.error(errorMessage(err)));
  }, [companyId]);

  // Every filter + the month live in the URL -- a report can be bookmarked,
  // refreshed, or handed to a colleague and land on the same view.
  useEffect(() => {
    const next = new URLSearchParams();
    next.set("month", month.format("YYYY-MM"));
    if (companyId) next.set("company_id", companyId);
    if (branchId) next.set("branch_id", branchId);
    if (teamId) next.set("team_id", teamId);
    if (agentId) next.set("agent_id", agentId);
    if (product) next.set("product", product);
    if (bucket) next.set("bucket", bucket);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, companyId, branchId, teamId, agentId, product, bucket]);

  const filters: DashboardFilters = useMemo(
    () => ({
      month: month.format("YYYY-MM"),
      company_id: companyId,
      branch_id: branchId,
      team_id: teamId,
      agent_id: agentId,
      product,
      bucket,
    }),
    [month, companyId, branchId, teamId, agentId, product, bucket],
  );

  const handleBreakdownRowsChange = useCallback((rows: BreakdownRow[], dimension: Dimension) => {
    setBreakdownRows(rows);
    setBreakdownDimension(dimension);
  }, []);

  const exportBreakdownCsv = () => {
    if (breakdownRows.length === 0) return;
    downloadCsv(
      `breakdown-${breakdownDimension}-${filters.month}.csv`,
      [
        breakdownDimension,
        "Allocated Amount",
        "Collected Amount",
        "Collected (Own Staff)",
        "Resolution %",
        "Rollback %",
        "Normalization %",
        "Recovery %",
        "Trail %",
        "Target Amount",
        "Achievement %",
      ],
      breakdownRows.map((r) => [
        r.label,
        r.allocated_amount,
        r.collected_amount,
        r.collected_by_own_staff_amount,
        r.resolution_pct ?? "",
        r.rollback_pct ?? "",
        r.normalization_pct ?? "",
        r.recovery_pct ?? "",
        r.trail_pct ?? "",
        r.target_amount ?? "",
        r.achievement_pct ?? "",
      ]),
    );
  };

  return (
    <div>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .ant-layout-sider, .ant-layout-header { display: none !important; }
        }
      `}</style>

      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Reports
        </Typography.Title>
        <Space>
          <Button icon={<DownloadOutlined />} disabled={breakdownRows.length === 0} onClick={exportBreakdownCsv}>
            Export breakdown as CSV
          </Button>
          <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
            Print
          </Button>
        </Space>
      </div>

      <Row gutter={[12, 12]} className="no-print" style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6} md={4}>
          <DatePicker picker="month" value={month} onChange={(m) => m && setMonth(m)} allowClear={false} style={{ width: "100%" }} />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Select
            style={{ width: "100%" }}
            title="All companies" placeholder="All companies"
            allowClear
            value={companyId}
            onChange={(v) => { setCompanyId(v ?? undefined); setProduct(undefined); setBucket(undefined); }}
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Select
            style={{ width: "100%" }}
            title="All branches" placeholder="All branches"
            allowClear
            value={branchId}
            onChange={(v) => setBranchId(v ?? undefined)}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Select
            style={{ width: "100%" }}
            title="All teams" placeholder="All teams"
            allowClear
            value={teamId}
            onChange={(v) => setTeamId(v ?? undefined)}
            options={teams.map((t) => ({ value: t.id, label: t.name }))}
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Select
            style={{ width: "100%" }}
            title="All agents" placeholder="All agents"
            allowClear
            showSearch
            optionFilterProp="label"
            value={agentId}
            onChange={(v) => setAgentId(v ?? undefined)}
            options={agentOptions.map((a) => ({ value: a.id, label: a.full_name }))}
          />
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Select
            style={{ width: "100%" }}
            title="All products" placeholder="All products"
            allowClear
            disabled={!companyId}
            value={product}
            onChange={(v) => setProduct(v ?? undefined)}
            options={products.map((p) => ({ value: p.raw_label, label: p.canonical_label || p.raw_label }))}
          />
        </Col>
      </Row>

      {companyId && buckets.length > 0 && (
        <Row gutter={[12, 12]} className="no-print" style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6} md={4}>
            <Select
              style={{ width: "100%" }}
              title="All buckets" placeholder="All buckets"
              allowClear
              value={bucket}
              onChange={(v) => setBucket(v ?? undefined)}
              options={buckets.map((b) => ({ value: b, label: b }))}
            />
          </Col>
        </Row>
      )}

      <div style={{ marginBottom: 16 }}>
        <BreakdownTable filters={filters} onRowsChange={handleBreakdownRowsChange} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <TrailAnalyticsCard filters={filters} />
      </div>

      <ExceptionPaymentsCard filters={filters} />
    </div>
  );
}
