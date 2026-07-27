import { Card, Modal, Table, Tabs, theme, Typography, message } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { lakh, compactCount } from "./format";
import type { DashboardFilters } from "./types";

interface RecallRow {
  company_id: string;
  company_name: string;
  recalled_count: number;
  recalled_amount: number;
}

interface RecalledCustomerRow {
  customer_id: string;
  loan_number: string;
  customer_name: string;
  company_name: string;
  recalled_at: string;
  last_bucket: string | null;
  last_due_amount: number | null;
  last_agent_name: string | null;
}

interface RecallReport {
  total_recalled_count: number;
  total_recalled_amount: number;
  lifetime_recalled_count: number;
  by_company: RecallRow[];
  customers: RecalledCustomerRow[];
}

/** Cases the lender pulled back this month -- distinct from `closed`, so a healthy book doesn't read as churn. */
export default function RecalledStatTile({ filters }: { filters: DashboardFilters }) {
  const { token } = theme.useToken();
  const [data, setData] = useState<RecallReport | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params: Record<string, string> = { month: filters.month };
    if (filters.company_id) params.company_id = filters.company_id;
    api
      .get("/reports/recalls", { params })
      .then((res) => {
        if (!cancelled) setData(res.data);
      })
      .catch((err) => {
        if (!cancelled) message.error(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filters.month, filters.company_id]);

  return (
    <>
      <Card
        size="small"
        hoverable
        onClick={() => setOpen(true)}
        style={{ background: token.colorFillTertiary, border: "none", cursor: "pointer" }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Recalled This Month
        </Typography.Text>
        <div className="money" style={{ fontSize: 20, fontWeight: 700, color: token.colorText }}>
          {compactCount(data?.total_recalled_count ?? 0)}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {data ? lakh(data.total_recalled_amount) : "—"} · lifetime book:{" "}
          {compactCount(data?.lifetime_recalled_count ?? 0)}
        </Typography.Text>
      </Card>
      <Modal
        title="Recalled Cases This Month"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={720}
      >
        <Tabs
          items={[
            {
              key: "customers",
              label: "Customer List",
              children: (
                <Table<RecalledCustomerRow>
                  rowKey="customer_id"
                  size="small"
                  pagination={data && data.customers.length > 10 ? { pageSize: 10 } : false}
                  dataSource={data?.customers ?? []}
                  locale={{ emptyText: "No recalls this month" }}
                  columns={[
                    { title: "Loan No", dataIndex: "loan_number" },
                    { title: "Customer", dataIndex: "customer_name", ellipsis: true },
                    { title: "Company", dataIndex: "company_name", ellipsis: true },
                    {
                      title: "Recalled",
                      dataIndex: "recalled_at",
                      render: (v: string) => dayjs(v).format("DD MMM YYYY"),
                    },
                    { title: "Last Bucket", dataIndex: "last_bucket", render: (v: string | null) => v ?? "-" },
                    {
                      title: "Last Due",
                      dataIndex: "last_due_amount",
                      align: "right",
                      render: (v: number | null) => (v != null ? lakh(v) : "-"),
                    },
                    {
                      title: "Last Agent",
                      dataIndex: "last_agent_name",
                      render: (v: string | null) => v ?? "-",
                    },
                  ]}
                />
              ),
            },
            {
              key: "by-company",
              label: "By Company",
              children: (
                <Table<RecallRow>
                  rowKey="company_id"
                  size="small"
                  pagination={false}
                  dataSource={data?.by_company ?? []}
                  locale={{ emptyText: "No recalls this month" }}
                  columns={[
                    { title: "Company", dataIndex: "company_name" },
                    { title: "Count", dataIndex: "recalled_count", align: "right" },
                    {
                      title: "Amount",
                      dataIndex: "recalled_amount",
                      align: "right",
                      render: (v: number) => lakh(v),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Modal>
    </>
  );
}
