import { Button, DatePicker, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { downloadCsv } from "../utils/csv";
import type { Branch, Team } from "../types";

const { RangePicker } = DatePicker;

interface AttendanceRecord {
  id: string;
  user_id: string;
  full_name: string;
  team_name: string | null;
  branch_name: string | null;
  punch_in_at: string;
  punch_out_at: string | null;
  punch_in_lat: number | null;
  punch_in_lng: number | null;
  punch_out_lat: number | null;
  punch_out_lng: number | null;
  duration_seconds: number;
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export default function AttendancePage() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<{ id: string; full_name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [branchId, setBranchId] = useState<string | undefined>();
  const [teamId, setTeamId] = useState<string | undefined>();
  const [agentId, setAgentId] = useState<string | undefined>();
  const [onDutyOnly, setOnDutyOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    Promise.all([
      api.get("/branches"),
      api.get("/teams"),
      api.get("/employees"),
    ]).then(([br, tm, emp]) => {
      setBranches(br.data.branches);
      setTeams(tm.data.teams);
      setAgents(
        (emp.data.employees as { id: string; full_name: string; is_active: boolean }[])
          .filter((e) => e.is_active),
      );
    }).catch((err) => message.error(errorMessage(err)));
  }, []);

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        from: range[0].format("YYYY-MM-DD"),
        to: range[1].format("YYYY-MM-DD"),
        page: p,
        per_page: 100,
      };
      if (branchId) params.branch_id = branchId;
      if (teamId) params.team_id = teamId;
      if (agentId) params.agent_id = agentId;
      if (onDutyOnly) params.on_duty_only = "true";
      const res = await api.get("/attendance-records", { params });
      setRecords(res.data.records);
      // Previously absent from the response, so AntD sized pagination off
      // dataSource.length (max 100) and page 2 was unreachable no matter
      // how many records actually existed.
      setTotal(res.data.total);
      setPage(p);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [range, branchId, teamId, agentId, onDutyOnly]);

  useEffect(() => {
    void load(1);
  }, [load]);

  const columns = [
    {
      title: "Employee",
      dataIndex: "full_name",
      render: (name: string, r: AttendanceRecord) => (
        <div>
          <div style={{ fontWeight: 600 }}>{name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.team_name ?? r.branch_name ?? "—"}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "Punch In",
      dataIndex: "punch_in_at",
      render: (v: string) => new Date(v).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }),
    },
    {
      title: "Punch Out",
      dataIndex: "punch_out_at",
      render: (v: string | null) =>
        v
          ? new Date(v).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })
          : <Tag color="green">On Duty</Tag>,
    },
    {
      title: "Duration",
      dataIndex: "duration_seconds",
      align: "right" as const,
      render: (v: number, r: AttendanceRecord) => (
        <span style={!r.punch_out_at ? { color: "#52c41a", fontWeight: 600 } : {}}>
          {fmtDuration(v)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Attendance Records
        </Typography.Title>
        <Button
          icon={<DownloadOutlined />}
          onClick={() =>
            downloadCsv(
              `attendance-${range[0].format("YYYY-MM-DD")}-to-${range[1].format("YYYY-MM-DD")}.csv`,
              ["Employee", "Team", "Punch In", "Punch Out", "Duration (min)"],
              records.map((r) => [
                r.full_name,
                r.team_name ?? "",
                // Raw ISO previously landed directly in the sheet -- unreadable
                // without a spreadsheet formula to convert it.
                dayjs(r.punch_in_at).format("DD/MM/YYYY HH:mm"),
                r.punch_out_at ? dayjs(r.punch_out_at).format("DD/MM/YYYY HH:mm") : "",
                Math.round(r.duration_seconds / 60),
              ]),
            )
          }
        >
          Export CSV
        </Button>
      </div>
      <Space wrap style={{ marginBottom: 16 }}>
        <RangePicker
          value={range}
          onChange={(v) => v && setRange(v as [Dayjs, Dayjs])}
          allowClear={false}
        />
        <Select
          style={{ width: 160 }}
          title="All branches" placeholder="All branches"
          allowClear
          value={branchId}
          onChange={(v) => { setBranchId(v ?? undefined); setTeamId(undefined); }}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Select
          style={{ width: 160 }}
          title="All teams" placeholder="All teams"
          allowClear
          value={teamId}
          onChange={(v) => setTeamId(v ?? undefined)}
          options={teams
            .filter((t) => !branchId || t.branch_id === branchId)
            .map((t) => ({ value: t.id, label: t.name }))}
        />
        <Select
          style={{ width: 180 }}
          title="All agents" placeholder="All agents"
          allowClear
          showSearch
          optionFilterProp="label"
          value={agentId}
          onChange={(v) => setAgentId(v ?? undefined)}
          options={agents.map((a) => ({ value: a.id, label: a.full_name }))}
        />
        <Space size={6}>
          <Switch size="small" checked={onDutyOnly} onChange={setOnDutyOnly} />
          <Typography.Text type="secondary">On duty only</Typography.Text>
        </Space>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={records}
        columns={columns}
        pagination={{
          current: page,
          pageSize: 100,
          total,
          showSizeChanger: false,
          onChange: (p) => load(p),
          showTotal: (t) => `${t} records`,
        }}
        // "on-duty-row" used to be set here with no matching CSS anywhere in
        // the app -- a highlight that silently never rendered. onRow's
        // inline style actually takes effect.
        onRow={(r: AttendanceRecord) =>
          r.punch_out_at === null ? { style: { background: "rgba(82, 196, 26, 0.08)" } } : {}
        }
      />
    </div>
  );
}
