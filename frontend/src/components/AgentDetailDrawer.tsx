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
import type { DashboardData } from "./dashboard/types";

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
 * Agent drill-down: own dashboard numbers (GET /reports/dashboard?agent_id=)
 * plus the recent-activity feed (GET /reports/agent-activity). Used from
 * OrgChartPage/TeamDetailDrawer click-through.
 *
 * KNOWN BROKEN since Phase 7 (backend): /reports/dashboard was deleted then;
 * this component was never in that phase's file list and has been calling a
 * 404 ever since. Phase 15 (web: delete the KPI surface) explicitly does NOT
 * touch this file either -- its own file list is App.tsx/AppLayout.tsx plus
 * an explicit instruction to keep BreakdownTable.tsx/format.ts/types.ts
 * because OrgChartPage still needs them, regardless of whether they still
 * work. See docs/KNOWN-ISSUES.md §2 for the full picture and what a fix
 * would need to look like.
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
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [activity, setActivity] = useState<AgentActivityRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!agentId) return;
    setLoading(true);
    Promise.all([
      api.get("/reports/dashboard", { params: { month, agent_id: agentId } }),
      api.get("/reports/agent-activity", { params: { agent_id: agentId, limit: 20 } }),
    ])
      .then(([dashRes, actRes]) => {
        setDashboard(dashRes.data);
        setActivity(actRes.data.activity);
      })
      .catch((err) => message.error(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [agentId, month]);

  useEffect(() => {
    if (!open || !agentId) return;
    setDashboard(null);
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
      {!loading && dashboard && (
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="Allocated">
              {lakh(dashboard.allocated.amount)} ({dashboard.allocated.count})
            </Descriptions.Item>
            <Descriptions.Item label="Collected (MTD)">{lakh(dashboard.collection.mtd_amount)}</Descriptions.Item>
            <Descriptions.Item label="Target">
              {dashboard.collection.target_amount != null ? lakh(dashboard.collection.target_amount) : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Achievement">{pctText(dashboard.collection.target_pct)}</Descriptions.Item>
          </Descriptions>

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
