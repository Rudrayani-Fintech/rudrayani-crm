import { Card, Spin, Typography } from "antd";
import { Column } from "@ant-design/plots";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { message } from "antd";
import { lakh } from "./format";
import { palette } from "../../theme/tokens";
import type { DashboardFilters } from "./types";

interface Point {
  month: string;
  collected: number;
}

/**
 * Blueprint's "Total Collection (Last 3 Months)" dark card: monthly bars with
 * the period total and a View All toggle that expands to the full history.
 */
export default function OverviewChart({ filters }: { filters: DashboardFilters }) {
  const [viewAll, setViewAll] = useState(false);
  const [points, setPoints] = useState<Point[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params: Record<string, string> = { months: viewAll ? "all" : "3" };
    for (const key of ["company_id", "branch_id", "team_id", "agent_id", "product", "bucket"] as const) {
      if (filters[key]) params[key] = filters[key]!;
    }
    api
      .get("/reports/overview", { params })
      .then((res) => {
        if (cancelled) return;
        setPoints(res.data.points);
        setTotal(res.data.total);
      })
      .catch((err) => {
        if (!cancelled) message.error(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewAll, filters]);

  const data = points.map((p) => ({
    month: dayjs(`${p.month}-01`).format("MMM'YY"),
    collected: p.collected,
  }));

  return (
    <Card
      style={{ background: palette.sidebarDark, border: "none" }}
      styles={{ body: { paddingTop: 16 } }}
      title={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <Typography.Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 14 }}>
              Total Collection ({viewAll ? "All Months" : "Last 3 Months"})
            </Typography.Text>
            <div className="money" style={{ color: "#D1FAE5", fontSize: 22, fontWeight: 700 }}>
              {new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(total)}
            </div>
          </div>
          <a style={{ color: palette.emerald, fontSize: 13 }} onClick={() => setViewAll((v) => !v)}>
            {viewAll ? "Last 3 Months" : "View All"}
          </a>
        </div>
      }
    >
      {loading ? (
        <div style={{ display: "grid", placeItems: "center", height: 260 }}>
          <Spin />
        </div>
      ) : (
        <Column
          data={data}
          xField="month"
          yField="collected"
          height={260}
          maxColumnWidth={28}
          style={{ radiusTopLeft: 6, radiusTopRight: 6, fill: palette.emerald }}
          axis={{
            x: { labelFill: "rgba(255,255,255,0.85)", line: false, tick: false },
            y: {
              labelFill: "rgba(255,255,255,0.7)",
              labelFormatter: (v: number) => lakh(v),
              grid: true,
              gridStroke: "rgba(255,255,255,0.25)",
              gridStrokeOpacity: 1,
              gridLineDash: [3, 5],
            },
          }}
          tooltip={{
            title: (d: { month: string }) => d.month,
            items: [
              {
                field: "collected",
                name: "Collected",
                valueFormatter: (v: number) => lakh(v),
              },
            ],
          }}
        />
      )}
    </Card>
  );
}
