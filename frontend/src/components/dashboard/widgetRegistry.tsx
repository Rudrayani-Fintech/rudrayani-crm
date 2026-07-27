import type { ReactNode } from "react";
import { Card, Col, Row, Tag } from "antd";
import BreakdownTable from "./BreakdownTable";
import BucketMismatchCard from "./BucketMismatchCard";
import BucketMovementCard from "./BucketMovementCard";
import DepositsRangeCard from "./DepositsRangeCard";
import ExceptionPaymentsCard from "./ExceptionPaymentsCard";
import MetricPanel from "./MetricPanel";
import MetricTabsCard from "./MetricTabsCard";
import OverviewChart from "./OverviewChart";
import RecalledStatTile from "./RecalledStatTile";
import SummaryStat from "./SummaryStat";
import TrailAnalyticsCard from "./TrailAnalyticsCard";
import { lakh, compactCount, pctText } from "./format";
import { palette } from "../../theme/tokens";
import { METRIC_TITLES, type DashboardData, type DashboardFilters, type MetricKey } from "./types";

export interface DashboardRenderCtx {
  data: DashboardData;
  filters: DashboardFilters;
  amountMode: boolean;
  activeMetric: MetricKey;
  setActiveMetric: (key: MetricKey) => void;
}

export interface DashboardWidget {
  id: string;
  title: string;
  render: (ctx: DashboardRenderCtx) => ReactNode;
  /** Spans both columns of the dashboard's 2-column grid (DashboardPage.tsx)
   *  -- widgets that are internally already a multi-column Row (the hero
   *  stats, the breakdown table, charts) want the full width; simple tiles
   *  pair up side by side. Defaults to false (half-width). */
  fullWidth?: boolean;
}

/**
 * Every card/section on the dashboard, as data instead of a fixed JSX
 * sequence — this is what makes show/hide + drag-reorder (DashboardPage.tsx
 * + DashboardCustomizer.tsx) possible. Granularity is per visually-distinct
 * card, not per row — e.g. "Recalled" and "Bucket Movement" used to share a
 * Row and are split here so either can be hidden independently.
 */
export const DASHBOARD_WIDGETS: DashboardWidget[] = [
  {
    id: "collection-hero",
    title: "Collection Summary",
    fullWidth: true,
    render: ({ data }) => (
      <Card
        size="small"
        style={{ borderTop: `3px solid ${palette.navy}`, borderRadius: 8 }}
        styles={{ body: { padding: "12px 16px" } }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "var(--rcrm-text)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Collection
          </span>
          <Tag color="cyan" style={{ fontSize: 11 }}>
            {data.days.elapsed}d elapsed · {data.days.left}d left
          </Tag>
        </div>
        <Row gutter={[12, 12]}>
          <Col xs={12} md={6}>
            <SummaryStat
              label="Collected Today"
              value={lakh(data.collection.today_amount)}
              accent="#13c2c2"
            />
          </Col>
          <Col xs={12} md={6}>
            <SummaryStat
              label="Collection MTD"
              value={lakh(data.collection.mtd_amount)}
              accent={palette.navy}
              sub={`Run rate: ${data.collection.run_rate_current != null ? lakh(data.collection.run_rate_current) + "/day" : "—"}`}
            />
          </Col>
          <Col xs={12} md={6}>
            <SummaryStat
              label="Collection Target"
              value={data.collection.target_amount != null ? lakh(data.collection.target_amount) : "—"}
              accent="#1677ff"
            />
          </Col>
          <Col xs={12} md={6}>
            <SummaryStat
              label="Target Achieved"
              value={pctText(data.collection.target_pct)}
              accent={
                data.collection.target_pct != null && data.collection.target_pct >= 80
                  ? "#52c41a"
                  : "#faad14"
              }
            />
          </Col>
          <Col xs={12} md={6}>
            <SummaryStat
              label="Required / Day"
              value={data.collection.run_rate_required != null ? lakh(data.collection.run_rate_required) : "On target"}
              accent="#ff7a45"
            />
          </Col>
          <Col xs={12} md={6}>
            <SummaryStat
              label="Portfolio (POS)"
              value={lakh(data.collection.pos_total)}
              accent={palette.navy}
              sub={
                data.collection.emi_over_pos_pct != null
                  ? `EMI target: ${pctText(data.collection.emi_over_pos_pct)} of POS`
                  : undefined
              }
            />
          </Col>
        </Row>
      </Card>
    ),
  },
  {
    // Previously the only chart in the entire product, and it sat dead last
    // on a page that's otherwise ~30 numbers in a single column. Moved
    // right after the hero stats so there's a visual anchor before the
    // wall of figures, not after it.
    id: "overview-chart",
    title: "Monthly Overview Chart",
    fullWidth: true,
    render: ({ filters }) => <OverviewChart filters={filters} />,
  },
  {
    id: "metric-gauge",
    title: "Metric Gauge",
    render: ({ data, amountMode, activeMetric, setActiveMetric }) => (
      <MetricTabsCard
        metrics={data.metrics}
        amountMode={amountMode}
        active={activeMetric}
        onChange={setActiveMetric}
      />
    ),
  },
  {
    id: "metric-panel-active",
    title: "Active Metric Detail",
    render: ({ data, amountMode, activeMetric }) => (
      <MetricPanel
        title={METRIC_TITLES[activeMetric]}
        metric={data.metrics[activeMetric]}
        amountMode={amountMode}
      />
    ),
  },
  {
    id: "metric-panel-others",
    title: "Other Metrics",
    fullWidth: true,
    render: ({ data, amountMode, activeMetric }) => {
      const otherMetrics = (Object.keys(METRIC_TITLES) as MetricKey[]).filter(
        (k) => k !== activeMetric,
      );
      return (
        <Row gutter={[16, 16]}>
          {otherMetrics.map((key) => (
            <Col xs={24} md={8} key={key}>
              <MetricPanel
                title={METRIC_TITLES[key]}
                metric={data.metrics[key]}
                amountMode={amountMode}
                compact
              />
            </Col>
          ))}
        </Row>
      );
    },
  },
  {
    id: "deposits-card",
    title: "Deposits (This Month)",
    render: ({ data }) => (
      <Card size="small" title="Deposits (This Month)" style={{ height: "100%" }}>
        <Row gutter={[10, 10]}>
          <Col span={8}>
            <SummaryStat label="Collected" value={lakh(data.deposits.collected)} accent={palette.navy} />
          </Col>
          <Col span={8}>
            <SummaryStat label="Deposited" value={lakh(data.deposits.deposited)} accent="#1677ff" />
          </Col>
          <Col span={8}>
            <SummaryStat label="Pending" value={lakh(data.deposits.pending)} accent="#faad14" />
          </Col>
        </Row>
      </Card>
    ),
  },
  {
    id: "deposits-range-card",
    title: "Deposits — Custom Range",
    render: ({ filters }) => <DepositsRangeCard filters={filters} />,
  },
  {
    id: "trail-activity-card",
    title: "Trail Activity",
    render: ({ data }) => (
      <Card size="small" title="Trail Activity" style={{ height: "100%" }}>
        <Row gutter={[10, 10]}>
          <Col span={8}>
            <SummaryStat label="Allocated" value={compactCount(data.trail.allocated_count)} accent="#722ed1" />
          </Col>
          <Col span={8}>
            <SummaryStat label="Trailed" value={compactCount(data.trail.uploaded_count)} accent="#13c2c2" />
          </Col>
          <Col span={8}>
            <SummaryStat label="Trail %" value={pctText(data.trail.pct)} accent="#eb2f96" />
          </Col>
        </Row>
      </Card>
    ),
  },
  {
    id: "recalled-tile",
    title: "Recalled Cases",
    render: ({ filters }) => <RecalledStatTile filters={filters} />,
  },
  {
    id: "bucket-movement-card",
    title: "Bucket Movement",
    render: ({ filters }) => <BucketMovementCard filters={filters} />,
  },
  {
    id: "bucket-mismatch",
    title: "DPD Cross-check",
    render: ({ filters }) => <BucketMismatchCard filters={filters} />,
  },
  {
    id: "exception-payments",
    title: "Payments Above Due Amount",
    fullWidth: true,
    render: ({ filters }) => <ExceptionPaymentsCard filters={filters} />,
  },
  {
    id: "breakdown-table",
    title: "Dimension Breakdown",
    fullWidth: true,
    render: ({ filters }) => <BreakdownTable filters={filters} />,
  },
  {
    id: "trail-analytics",
    title: "Trail / Disposition Analytics",
    fullWidth: true,
    render: ({ filters }) => <TrailAnalyticsCard filters={filters} />,
  },
];

export const DASHBOARD_WIDGET_IDS = DASHBOARD_WIDGETS.map((w) => w.id);

/** Widgets that only make sense for managers (agents get a self-scoped, filter-free view). */
const MANAGER_ONLY_WIDGET_IDS = new Set([
  "recalled-tile",
  "bucket-movement-card",
  "bucket-mismatch",
  "breakdown-table",
  "exception-payments",
]);

export interface WidgetLayoutEntry {
  id: string;
  visible: boolean;
  order: number;
}

/** The "default default" — used until a user saves their own layout. */
export function getRoleDefaultLayout(isManager: boolean): WidgetLayoutEntry[] {
  return DASHBOARD_WIDGETS.map((w, i) => ({
    id: w.id,
    visible: isManager || !MANAGER_ONLY_WIDGET_IDS.has(w.id),
    order: i,
  }));
}

/**
 * Merge a saved layout with the registry: keeps saved order/visibility for
 * known ids, appends any widget the registry has that the saved layout
 * doesn't (e.g. shipped after the user last saved), and drops ids the
 * registry no longer knows about.
 */
export function applyLayout(
  savedLayout: WidgetLayoutEntry[] | null,
  isManager: boolean,
): DashboardWidget[] {
  const layout = savedLayout ?? getRoleDefaultLayout(isManager);
  const known = new Set(DASHBOARD_WIDGET_IDS);
  const byId = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));

  const entries = layout.filter((e) => known.has(e.id));
  const coveredIds = new Set(entries.map((e) => e.id));
  const missing = DASHBOARD_WIDGETS.filter((w) => !coveredIds.has(w.id)).map((w, i) => ({
    id: w.id,
    visible: isManager || !MANAGER_ONLY_WIDGET_IDS.has(w.id),
    order: entries.length + i,
  }));

  return [...entries, ...missing]
    .filter((e) => e.visible)
    .sort((a, b) => a.order - b.order)
    .map((e) => byId.get(e.id)!);
}
