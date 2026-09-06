import { Descriptions, Drawer, Empty, Space, Spin, Tag, Timeline, Typography, message } from "antd";
import {
  DollarOutlined,
  EnvironmentOutlined,
  FileTextOutlined,
  PhoneOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { lakh, pctText } from "./dashboard/format";
import type { BreakdownRow } from "./dashboard/BreakdownTable";

/** The subset of a BreakdownRow this drawer renders. */
interface AgentPerformance {
  allocated_amount: number;
  allocated_count: number;
  collected_amount: number;
  target_amount: number | null;
  achievement_pct: number | null;
}

interface AgentActivityRow {
  kind: "call" | "payment" | "ptp" | "field_visit";
  id: string;
  at: string;
  customer_name: string;
  loan_number: string;
  detail: string | null;
}

const KIND_ICON: Record<AgentActivityRow["kind"], React.ReactNode> = {
  call: <PhoneOutlined style={{ color: "#1677ff" }} />,
  payment: <DollarOutlined style={{ color: "#52c41a" }} />,
  ptp: <FileTextOutlined style={{ color: "#faad14" }} />,
  field_visit: <EnvironmentOutlined style={{ color: "#722ed1" }} />,
};

const KIND_LABEL: Record<AgentActivityRow["kind"], string> = {
  call: "Call logged",
  payment: "Payment collected",
  ptp: "PTP",
  field_visit: "Field visit",
};

/**
 * Agent drill-down: this agent's allocated-vs-collected numbers plus their
 * recent-activity feed. Used from OrgChartPage/TeamDetailDrawer click-through.
 *
 * The performance half used to call GET /reports/dashboard, which Phase 7
 * deleted -- this component was never in that phase's file list, so it 404'd
 * (blank drawer + "Not found" toast) from then until an audit caught it. It
 * now reads the single agent-dimension row from GET /reports/breakdown, the
 * same aggregate the branch/team drawers use, so all three drill-downs share
 * one endpoint and one scope clamp.
 */
export default function AgentDetailDrawer({
  agentId,
  agentName,
  month,
  open,
  onClose,
}: {
  agentId: string | null;
  agentName?: string;
  month: string; // YYYY-MM
  open: boolean;
  onClose: () => void;
}) {
  const [performance, setPerformance] = useState<AgentPerformance | null>(null);
  const [activity, setActivity] = useState<AgentActivityRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!agentId) return;
    setLoading(true);
    Promise.all([
      api.get("/reports/breakdown", {
        params: { month, dimension: "agent", agent_id: agentId },
      }),
      api.get("/reports/agent-activity", { params: { agent_id: agentId, limit: 20 } }),
    ])
      .then(([breakdownRes, actRes]) => {
        // Scoped to one agent_id, so at most one row comes back. An agent with
        // no allocated book for the month legitimately has none -- show the
        // activity feed rather than an error.
        const row: BreakdownRow | undefined = (breakdownRes.data.rows ?? []).find(
          (r: BreakdownRow) => r.key === agentId,
        ) ?? (breakdownRes.data.rows ?? [])[0];
        setPerformance(
          row
            ? {
                allocated_amount: row.allocated_amount,
                allocated_count: row.allocated_count,
                collected_amount: row.collected_amount,
                target_amount: row.target_amount,
                achievement_pct: row.achievement_pct,
              }
            : null,
        );
        setActivity(actRes.data.activity);
      })
      .catch((err) => message.error(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [agentId, month]);

  useEffect(() => {
    if (!open || !agentId) return;
    setPerformance(null);
    setActivity([]);
    load();
  }, [open, agentId, load]);

  return (
    <Drawer title={agentName ?? "Agent"} open={open} onClose={onClose} width={620} destroyOnHidden>
      {loading && (
        <div style={{ display: "grid", placeItems: "center", height: 200 }}>
          <Spin size="large" />
        </div>
      )}
      {!loading && (
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          {performance ? (
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="Allocated">
                {lakh(performance.allocated_amount)} ({performance.allocated_count})
              </Descriptions.Item>
              <Descriptions.Item label="Collected (MTD)">
                {lakh(performance.collected_amount)}
              </Descriptions.Item>
              <Descriptions.Item label="Target">
                {performance.target_amount != null ? lakh(performance.target_amount) : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="Achievement">
                {pctText(performance.achievement_pct)}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Empty
              description="No allocated book for this month"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          )}

          <div>
            <Typography.Title level={5}>Recent Activity</Typography.Title>
            {activity.length === 0 ? (
              <Empty description="No recent activity" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Timeline
                items={activity.map((a) => ({
                  dot: KIND_ICON[a.kind],
                  children: (
                    <Space direction="vertical" size={0}>
                      <Space size={6} wrap>
                        <Typography.Text strong>{KIND_LABEL[a.kind]}</Typography.Text>
                        <Tag>{a.customer_name}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {a.loan_number}
                        </Typography.Text>
                      </Space>
                      {a.detail && <Typography.Text type="secondary">{a.detail}</Typography.Text>}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(a.at).format("DD MMM YYYY, HH:mm")}
                      </Typography.Text>
                    </Space>
                  ),
                }))}
              />
            )}
          </div>
        </Space>
      )}
    </Drawer>
  );
}
