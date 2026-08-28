import { Table, Empty, Tag, Typography, Tooltip, theme } from "antd";
import type { TableProps } from "antd";
import dayjs from "dayjs";
import type { AgentActivityRow } from "./types";

interface ActivityTableProps {
  data: AgentActivityRow[];
  loading?: boolean;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onRowClick?: (record: AgentActivityRow) => void;
}

export default function ActivityTable({
  data,
  loading,
  total,
  page,
  pageSize,
  onPageChange,
  onRowClick,
}: ActivityTableProps) {
  const { token } = theme.useToken();

  const actionTypeColors: Record<string, string> = {
    call: token.colorInfo,
    payment: token.colorSuccess,
    ptp: token.colorWarning,
    field_visit: token.colorError,
  };

  const actionTypeLabels: Record<string, string> = {
    call: "Call",
    payment: "Payment",
    ptp: "PTP",
    field_visit: "Field Visit",
  };

  const ptpStatusColors: Record<string, string> = {
    pending: "default",
    kept: "success",
    broken: "error",
  };

  const ptpStatusLabels: Record<string, string> = {
    pending: "Pending",
    kept: "Kept",
    broken: "Broken",
  };

  const agentTypeLabels: Record<string, string> = {
    telecaller: "Telecaller",
    field_agent: "Field Agent",
  };

  const columns: TableProps<AgentActivityRow>["columns"] = [
    {
      title: "Time",
      dataIndex: "at",
      key: "at",
      width: 90,
      fixed: "left",
      render: (at: string) => {
        const time = dayjs(at).format("HH:mm");
        return <span style={{ fontFamily: token.fontFamilyCode }}>{time}</span>;
      },
    },
    {
      title: "Agent",
      dataIndex: "agent_name",
      key: "agent_name",
      width: 160,
      fixed: "left",
      render: (name: string, record: AgentActivityRow) => (
        <div>
          <div>{name}</div>
          {record.agent_type && (
            <Tag color={record.agent_type === "telecaller" ? "blue" : "cyan"} style={{ marginTop: 4 }}>
              {agentTypeLabels[record.agent_type]}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: "Action",
      dataIndex: "kind",
      key: "kind",
      width: 110,
      render: (kind: string) => (
        <Tag color={actionTypeColors[kind]}>
          {actionTypeLabels[kind] || kind}
        </Tag>
      ),
    },
    {
      title: "Customer",
      dataIndex: "customer_name",
      key: "customer_name",
      width: 180,
      render: (name: string) => (
        <Tooltip title={name}>
          <span style={{ cursor: "pointer", color: token.colorPrimary }}>
            {name}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Branch",
      dataIndex: "customer_branch_name",
      key: "customer_branch_name",
      width: 120,
      render: (branch: string | null) => branch || "—",
    },
    {
      title: "Bucket",
      dataIndex: "customer_bucket",
      key: "customer_bucket",
      width: 110,
      render: (bucket: string | null) => bucket || "—",
    },
    {
      title: "Amount",
      dataIndex: "amount",
      key: "amount",
      width: 110,
      align: "right" as const,
      render: (amount: string | null) => {
        if (!amount) return "—";
        return (
          <span style={{ fontFamily: token.fontFamilyCode }}>
            ₹{parseFloat(amount).toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        );
      },
    },
    {
      title: "Disposition",
      dataIndex: "detail",
      key: "detail",
      width: 140,
      render: (detail: string | null, record: AgentActivityRow) =>
        record.kind === "call" ? detail || "—" : "—",
    },
    {
      title: "PTP Status",
      dataIndex: "ptp_status",
      key: "ptp_status",
      width: 100,
      render: (status: string | null) =>
        status ? (
          <Tag color={ptpStatusColors[status]}>
            {ptpStatusLabels[status]}
          </Tag>
        ) : (
          "—"
        ),
    },
    {
      title: "Remark",
      dataIndex: "remark",
      key: "remark",
      width: 200,
      render: (remark: string | null) =>
        remark ? (
          <Tooltip title={remark}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
              {remark}
            </span>
          </Tooltip>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div style={{ marginTop: token.margin }}>
      <Typography.Text type="secondary" style={{ marginBottom: token.marginSM }}>
        Showing {data.length > 0 ? (page - 1) * pageSize + 1 : 0} to{" "}
        {Math.min(page * pageSize, total)} of {total.toLocaleString("en-IN")} actions on{" "}
        {dayjs().format("DD MMM YYYY")}
      </Typography.Text>

      <Table<AgentActivityRow>
        columns={columns}
        dataSource={data}
        loading={loading}
        rowKey="id"
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: onPageChange,
          showSizeChanger: false,
        }}
        locale={{
          emptyText: (
            <Empty
              description="No agent activity matches these filters"
              style={{ marginTop: 48 }}
            />
          ),
        }}
        onRow={(record) => ({
          onClick: () => onRowClick?.(record),
          style: { cursor: onRowClick ? "pointer" : "default" },
        })}
        scroll={{ x: 1700 }}
        size="small"
      />
    </div>
  );
}
