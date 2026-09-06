import { Card, Progress, Segmented, Table } from "antd";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { message } from "antd";
import { lakh, pctText } from "./format";
import type { DashboardFilters } from "./types";

export type Dimension = "company" | "product" | "bucket" | "branch" | "team" | "agent";

const DIMENSION_OPTIONS: { label: string; value: Dimension }[] = [
  { label: "Company", value: "company" },
  { label: "Product", value: "product" },
  { label: "Bucket", value: "bucket" },
  { label: "Branch", value: "branch" },
  { label: "Team", value: "team" },
  { label: "Agent", value: "agent" },
];

export interface BreakdownRow {
  key: string | null;
  label: string;
  allocated_amount: number;
  allocated_count: number;
  /** Money collected against this row's allocated book, regardless of who collected it. */
  collected_amount: number;
  /** Money collected by staff belonging to this branch/team/agent -- can differ
   *  from collected_amount for multi-branch telecallers, mid-month reallocation,
   *  or a manager recording on an agent's behalf. Same as collected_amount for
   *  company/product/bucket rows. */
  collected_by_own_staff_amount: number;
  resolution_pct: number | null;
  rollback_pct: number | null;
  normalization_pct: number | null;
  recovery_pct: number | null;
  trail_pct: number | null;
  target_amount: number | null;
  achievement_pct: number | null;
}

/**
 * The "product wise view" the dashboard blueprint calls for, generalized to
 * every cut the report engine supports. Product/bucket rows have no target
 * (they're narrowing filters in the targets model, not their own scope
 * level) -- shown as "—" rather than a misleading 0%.
 *
 * Was broken from Phase 7 (which deleted GET /reports/breakdown) until an
 * audit found the Org Chart and Branches drill-downs 404ing. The route is
 * restored -- dimensionBreakdown() had never been deleted, only its HTTP
 * exposure -- so this component is unchanged and working again. Reached from
 * BranchDetailDrawer.tsx and TeamDetailDrawer.tsx, and through them from
 * OrgChartPage.tsx and BranchesPage.tsx.
 */
export default function BreakdownTable({
  filters,
  defaultDimension = "product",
  onRowClick,
  onRowsChange,
}: {
  filters: DashboardFilters;
  defaultDimension?: Dimension;
  /** Optional click-through (Management Dashboard's branch→team→agent drill-down). Rows for
   *  dimensions without a stable id (product/bucket, key is null) are not clickable. */
  onRowClick?: (dimension: Dimension, row: BreakdownRow) => void;
  /** Lets a parent (the Reports page's CSV export) see the current rows/dimension without
   *  duplicating the fetch itself. */
  onRowsChange?: (rows: BreakdownRow[], dimension: Dimension) => void;
}) {
  const [dimension, setDimension] = useState<Dimension>(defaultDimension);
  const [rows, setRows] = useState<BreakdownRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params: Record<string, string> = { month: filters.month, dimension };
    for (const key of ["company_id", "branch_id", "team_id", "agent_id", "product", "bucket"] as const) {
      if (filters[key]) params[key] = filters[key]!;
    }
    api
      .get("/reports/breakdown", { params })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        onRowsChange?.(res.data.rows, dimension);
      })
      .catch((err) => {
        if (!cancelled) message.error(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // A fast dimension/filter switch must not let an earlier, slower
    // response land after a newer one and repaint stale rows.
    return () => {
      cancelled = true;
    };
    // onRowsChange intentionally excluded -- an inline callback from the
    // parent must not itself trigger a refetch, only dimension/filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension, filters]);

  return (
    <Card
      size="small"
      title="Breakdown"
      extra={
        <Segmented
          size="small"
          value={dimension}
          onChange={(v) => setDimension(v as Dimension)}
          options={DIMENSION_OPTIONS}
        />
      }
    >
      <Table<BreakdownRow>
        rowKey={(r) => r.key ?? r.label}
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
        scroll={{ x: 760 }}
        onRow={
          onRowClick && (dimension === "branch" || dimension === "team" || dimension === "agent")
            ? (row) =>
                row.key
                  ? { onClick: () => onRowClick(dimension, row), style: { cursor: "pointer" } }
                  : {}
            : undefined
        }
        columns={[
          { title: DIMENSION_OPTIONS.find((d) => d.value === dimension)?.label, dataIndex: "label" },
          {
            title: "Allocated",
            dataIndex: "allocated_amount",
            align: "right",
            render: (v: number) => <span className="money">{lakh(v)}</span>,
          },
          {
            title: "Collected",
            dataIndex: "collected_amount",
            align: "right",
            render: (v: number) => <span className="money">{lakh(v)}</span>,
          },
          ...(dimension === "branch" || dimension === "team" || dimension === "agent"
            ? [
                {
                  title: "Collected (own staff)",
                  dataIndex: "collected_by_own_staff_amount",
                  align: "right" as const,
                  render: (v: number, row: BreakdownRow) => (
                    <span className="money" style={v !== row.collected_amount ? { color: "#d4380d" } : undefined}>
                      {lakh(v)}
                    </span>
                  ),
                },
              ]
            : []),
          {
            title: "Resolution",
            dataIndex: "resolution_pct",
            align: "right",
            render: (v: number | null) => pctText(v),
          },
          {
            title: "Rollback",
            dataIndex: "rollback_pct",
            align: "right",
            render: (v: number | null) => pctText(v),
          },
          {
            title: "Normalization",
            dataIndex: "normalization_pct",
            align: "right",
            render: (v: number | null) => pctText(v),
          },
          {
            title: "Recovery",
            dataIndex: "recovery_pct",
            align: "right",
            render: (v: number | null) => pctText(v),
          },
          {
            title: "Trail",
            dataIndex: "trail_pct",
            align: "right",
            render: (v: number | null) => pctText(v),
          },
          {
            title: "Target",
            dataIndex: "target_amount",
            align: "right",
            render: (v: number | null) => (v != null ? lakh(v) : "—"),
          },
          {
            title: "Achievement",
            dataIndex: "achievement_pct",
            width: 160,
            render: (v: number | null) =>
              v != null ? (
                <Progress percent={Math.min(v, 100)} size="small" status={v >= 100 ? "success" : "active"} />
              ) : (
                "—"
              ),
          },
        ]}
      />
    </Card>
  );
}
