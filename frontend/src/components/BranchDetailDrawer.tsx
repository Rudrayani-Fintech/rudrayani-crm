import { Collapse, Descriptions, Drawer, Space, Spin, Table, Tag, message } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { rupees as fmtAmount } from "../utils/money";
import BreakdownTable from "./dashboard/BreakdownTable";
import type { DashboardFilters } from "./dashboard/types";

interface BranchTeam {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
}

interface BranchTarget {
  id: string;
  metric: string;
  target_amount: string | number | null;
  target_count: number | null;
  product: string | null;
  bucket: string | null;
  company_name: string | null;
}

interface DepositPayment {
  id: string;
  amount: string | number;
  mode: string | null;
  paid_at: string;
  deposited_at: string | null;
  customer_name: string;
  loan_number: string;
  company_name: string;
  collected_by_name: string;
  deposited_by_name: string | null;
}

interface BranchDetail {
  branch: { id: string; name: string; created_at: string };
  month: string;
  teams: BranchTeam[];
  team_count: number;
  agent_count: number;
  targets: BranchTarget[];
  deposits: {
    collected: number;
    deposited: number;
    pending: number;
    payments: DepositPayment[];
  };
}

const orDash = (v: string | number | null | undefined) => (v == null || v === "" ? "-" : v);

const METRIC_LABEL: Record<string, string> = {
  resolution: "Resolution",
  rollback: "Roll Back",
  normalization: "Normalization",
  recovery: "Recovery",
  collection: "Collection",
};

/**
 * Branch drill-down drawer (Phase 9). Modeled on CustomerDetailDrawer: one
 * aggregating fetch to GET /branches/:id, sections rendered inside Phase 3's
 * collapsible-section pattern (<Collapse items={...}>) for density. The
 * agent-wise breakdown section reuses BreakdownTable as-is (own fetch to
 * /reports/breakdown, dimension locked implicitly by the branch_id filter).
 */
export default function BranchDetailDrawer({
  branchId,
  open,
  onClose,
}: {
  branchId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<BranchDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const loadDetail = useCallback(() => {
    if (!branchId) return;
    api
      .get(`/branches/${branchId}`)
      .then((res) => setDetail(res.data))
      .catch((err) => message.error(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [branchId]);

  useEffect(() => {
    if (!open || !branchId) return;
    setDetail(null);
    setLoading(true);
    loadDetail();
  }, [open, branchId, loadDetail]);

  const breakdownFilters: DashboardFilters | null = detail
    ? { month: detail.month, branch_id: detail.branch.id }
    : null;

  return (
    <Drawer title={detail ? detail.branch.name : "Branch"} open={open} onClose={onClose} width={760}>
      {loading && (
        <div style={{ display: "grid", placeItems: "center", height: 200 }}>
          <Spin size="large" />
        </div>
      )}
      {!loading && detail && (
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="Created">
              {dayjs(detail.branch.created_at).format("DD MMM YYYY")}
            </Descriptions.Item>
            <Descriptions.Item label="Month">
              {dayjs(detail.month, "YYYY-MM").format("MMM YYYY")}
            </Descriptions.Item>
            <Descriptions.Item label="Teams">{detail.team_count}</Descriptions.Item>
            <Descriptions.Item label="Active Agents">{detail.agent_count}</Descriptions.Item>
          </Descriptions>

          <Collapse
            defaultActiveKey={["teams", "agents"]}
            items={[
              {
                key: "teams",
                label: `Team Details (${detail.teams.length})`,
                children: (
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={detail.teams}
                    locale={{ emptyText: "No teams in this branch" }}
                    columns={[
                      { title: "Team", dataIndex: "name" },
                      { title: "Active Members", dataIndex: "member_count", align: "right" },
                      {
                        title: "Created",
                        dataIndex: "created_at",
                        render: (v: string) => dayjs(v).format("DD MMM YYYY"),
                      },
                    ]}
                  />
                ),
              },
              {
                key: "agents",
                label: "Agent-wise Breakdown",
                children: breakdownFilters ? <BreakdownTable filters={breakdownFilters} /> : null,
              },
              {
                key: "targets",
                label: `Targets (${dayjs(detail.month, "YYYY-MM").format("MMM YYYY")})`,
                children: (
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={detail.targets}
                    locale={{ emptyText: "No targets set for this branch this month" }}
                    columns={[
                      { title: "Metric", dataIndex: "metric", render: (v: string) => METRIC_LABEL[v] ?? v },
                      { title: "Company", dataIndex: "company_name", render: orDash },
                      { title: "Product", dataIndex: "product", render: orDash },
                      { title: "Bucket", dataIndex: "bucket", render: orDash },
                      {
                        title: "Target Amount",
                        dataIndex: "target_amount",
                        align: "right",
                        render: fmtAmount,
                      },
                      {
                        title: "Target Count",
                        dataIndex: "target_count",
                        align: "right",
                        render: orDash,
                      },
                    ]}
                  />
                ),
              },
              {
                key: "deposits",
                label: "Deposits",
                children: (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Space wrap>
                      <Tag color="blue">Collected: {fmtAmount(detail.deposits.collected)}</Tag>
                      <Tag color="green">Deposited: {fmtAmount(detail.deposits.deposited)}</Tag>
                      <Tag color="orange">Pending: {fmtAmount(detail.deposits.pending)}</Tag>
                    </Space>
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={detail.deposits.payments.length > 10 ? { pageSize: 10 } : false}
                      dataSource={detail.deposits.payments}
                      locale={{ emptyText: "No payments collected this month" }}
                      columns={[
                        { title: "Customer", dataIndex: "customer_name" },
                        { title: "Loan No.", dataIndex: "loan_number" },
                        { title: "Company", dataIndex: "company_name" },
                        { title: "Collected By", dataIndex: "collected_by_name" },
                        { title: "Amount", dataIndex: "amount", align: "right", render: fmtAmount },
                        {
                          title: "Paid At",
                          dataIndex: "paid_at",
                          render: (v: string) => dayjs(v).format("DD MMM YYYY"),
                        },
                        {
                          title: "Deposited",
                          dataIndex: "deposited_at",
                          render: (v: string | null) => (v ? dayjs(v).format("DD MMM YYYY") : "Pending"),
                        },
                      ]}
                    />
                  </Space>
                ),
              },
            ]}
          />
        </Space>
      )}
    </Drawer>
  );
}
