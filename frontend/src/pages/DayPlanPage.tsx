import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  DatePicker,
  Empty,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { api } from "../api/client";
import { rupees as rupee } from "../utils/money";

const { Text } = Typography;

interface DayPlanAgent {
  user_id: string;
  full_name: string;
  is_field_agent: boolean;
  is_telecaller: boolean;
  team_name: string | null;
  branch_name: string | null;
  attendance: { first_in: string | null; last_out: string | null; on_duty: boolean };
  ptps_due: { count: number; total_amount: number };
  reminders_due: { count: number };
  activity: { calls: number; payments_count: number; payments_total: number };
}

interface AgentDetail {
  ptps: { id: string; customer_name: string; loan_number: string; amount: number; promised_date: string }[];
  reminders: { id: string; customer_name: string | null; loan_number: string | null; remind_at: string; note: string | null }[];
}

function AttendanceTag({ attendance }: { attendance: DayPlanAgent["attendance"] }) {
  if (attendance.on_duty) return <Tag color="green">On duty since {dayjs(attendance.first_in).format("HH:mm")}</Tag>;
  if (attendance.first_in) {
    return (
      <Tag color="default">
        Punched out {attendance.last_out ? dayjs(attendance.last_out).format("HH:mm") : ""}
      </Tag>
    );
  }
  return <Tag color="red">Absent</Tag>;
}

function AgentDetailRow({ userId, date }: { userId: string; date: string }) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<AgentDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/day-plan/agent/${userId}`, { params: { date } })
      .then((res) => !cancelled && setDetail(res.data))
      .catch(() => !cancelled && message.error("Could not load this agent's detail"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [userId, date]);

  if (loading) return <Spin size="small" />;
  if (!detail || (detail.ptps.length === 0 && detail.reminders.length === 0)) {
    return <Empty description="Nothing due" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      {detail.ptps.length > 0 && (
        <div>
          <Text strong>PTPs due</Text>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={detail.ptps}
            columns={[
              { title: "Customer", dataIndex: "customer_name" },
              { title: "Loan No.", dataIndex: "loan_number" },
              { title: "Amount", dataIndex: "amount", render: (v: number) => rupee(Number(v)) },
              { title: "Promised", dataIndex: "promised_date", render: (v: string) => dayjs(v).format("DD MMM") },
            ]}
          />
        </div>
      )}
      {detail.reminders.length > 0 && (
        <div>
          <Text strong>Reminders due</Text>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={detail.reminders}
            columns={[
              { title: "Customer", dataIndex: "customer_name", render: (v: string | null) => v ?? "—" },
              { title: "Time", dataIndex: "remind_at", render: (v: string) => dayjs(v).format("HH:mm") },
              { title: "Note", dataIndex: "note", render: (v: string | null) => v ?? "—" },
            ]}
          />
        </div>
      )}
    </Space>
  );
}

export default function DayPlanPage() {
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [agents, setAgents] = useState<DayPlanAgent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: Dayjs) => {
    setLoading(true);
    try {
      const res = await api.get("/day-plan", { params: { date: d.format("YYYY-MM-DD") } });
      setAgents(res.data.agents);
    } catch {
      message.error("Could not load the day plan");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(date);
  }, [date, load]);

  const columns = [
    { title: "Agent", dataIndex: "full_name" },
    { title: "Team", dataIndex: "team_name", render: (v: string | null) => v ?? "—" },
    {
      title: "Attendance",
      key: "attendance",
      render: (_: unknown, row: DayPlanAgent) => <AttendanceTag attendance={row.attendance} />,
    },
    {
      title: "PTPs Due",
      key: "ptps_due",
      render: (_: unknown, row: DayPlanAgent) =>
        row.ptps_due.count > 0 ? (
          <Tag color="orange">
            {row.ptps_due.count} · {rupee(row.ptps_due.total_amount)}
          </Tag>
        ) : (
          "—"
        ),
    },
    {
      title: "Reminders Due",
      key: "reminders_due",
      render: (_: unknown, row: DayPlanAgent) =>
        row.reminders_due.count > 0 ? <Tag color="blue">{row.reminders_due.count}</Tag> : "—",
    },
    { title: "Calls", key: "calls", render: (_: unknown, row: DayPlanAgent) => row.activity.calls },
    {
      title: "Payments",
      key: "payments",
      render: (_: unknown, row: DayPlanAgent) =>
        row.activity.payments_count > 0
          ? `${row.activity.payments_count} · ${rupee(row.activity.payments_total)}`
          : "—",
    },
  ];

  return (
    <Card title="Day Plan">
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <Space>
          <DatePicker
            value={date}
            allowClear={false}
            onChange={(d) => d && setDate(d)}
            disabledDate={(d) => d.isAfter(dayjs(), "day")}
          />
          <Button icon={<ReloadOutlined />} onClick={() => load(date)}>
            Refresh
          </Button>
        </Space>
        <Table
          rowKey="user_id"
          loading={loading}
          columns={columns}
          dataSource={agents}
          expandable={{
            expandedRowRender: (row) => (
              <AgentDetailRow userId={row.user_id} date={date.format("YYYY-MM-DD")} />
            ),
          }}
          pagination={false}
        />
      </Space>
    </Card>
  );
}
