import { Card, Col, DatePicker, Row, Space, Spin, theme, Typography, message } from "antd";
import { Column } from "@ant-design/plots";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { compactCount, pctText } from "./format";
import { palette } from "../../theme/tokens";
import type { DashboardFilters } from "./types";

const { RangePicker } = DatePicker;

interface TrailAnalytics {
  total_trails: number;
  unique_customers_contacted: number;
  by_result_code: { result_code: string; count: number }[];
  ptps_created: number;
  ptps_kept: number;
  ptps_broken: number;
  ptp_conversion_pct: number | null;
}

// Uses antd's resolved theme tokens (not the static light-only `palette`
// import) so the tile background actually flips with light/dark mode --
// see SummaryStat.tsx for the same fix and the bug it addresses.
function Stat({ label, value }: { label: string; value: string }) {
  const { token } = theme.useToken();
  return (
    <div style={{ background: token.colorFillTertiary, borderRadius: 8, padding: "10px 14px" }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <div className="money" style={{ fontSize: 20, fontWeight: 700, color: token.colorText }}>
        {value}
      </div>
    </div>
  );
}

/** Result-code counts + PTP conversion over a free date range (defaults to the dashboard's selected month). */
export default function TrailAnalyticsCard({ filters }: { filters: DashboardFilters }) {
  const monthStart = dayjs(`${filters.month}-01`);
  const [range, setRange] = useState<[Dayjs, Dayjs]>([monthStart.startOf("month"), monthStart.endOf("month")]);
  const [data, setData] = useState<TrailAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

  // Snap back to the new month whenever the dashboard's month filter changes.
  useEffect(() => {
    const m = dayjs(`${filters.month}-01`);
    setRange([m.startOf("month"), m.endOf("month")]);
  }, [filters.month]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params: Record<string, string> = {
      from: range[0].format("YYYY-MM-DD"),
      to: range[1].format("YYYY-MM-DD"),
    };
    for (const key of ["company_id", "team_id", "agent_id", "product", "bucket"] as const) {
      if (filters[key]) params[key] = filters[key]!;
    }
    api
      .get("/reports/trail", { params })
      .then((res) => {
        if (!cancelled) setData(res.data);
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
  }, [range, filters]);

  const chartData = (data?.by_result_code ?? []).slice(0, 10).map((r) => ({
    result_code: r.result_code,
    count: r.count,
  }));

  return (
    <Card
      size="small"
      title="Trail Analytics"
      extra={
        <RangePicker
          size="small"
          value={range}
          onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
          allowClear={false}
        />
      }
    >
      {loading || !data ? (
        <div style={{ display: "grid", placeItems: "center", height: 200 }}>
          <Spin />
        </div>
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Row gutter={[10, 10]}>
            <Col span={8}>
              <Stat label="Total Trails" value={compactCount(data.total_trails)} />
            </Col>
            <Col span={8}>
              <Stat label="Customers Contacted" value={compactCount(data.unique_customers_contacted)} />
            </Col>
            <Col span={8}>
              <Stat label="PTP Conversion" value={pctText(data.ptp_conversion_pct)} />
            </Col>
          </Row>
          {chartData.length > 0 ? (
            <Column
              data={chartData}
              xField="result_code"
              yField="count"
              height={220}
              maxColumnWidth={28}
              style={{ radiusTopLeft: 4, radiusTopRight: 4, fill: palette.navy }}
              axis={{ x: { labelAutoRotate: true }, y: { grid: true } }}
              tooltip={{
                title: (d: { result_code: string }) => d.result_code,
                items: [{ field: "count", name: "Count" }],
              }}
            />
          ) : (
            <Typography.Text type="secondary">No dispositioned calls in this range</Typography.Text>
          )}
        </Space>
      )}
    </Card>
  );
}
