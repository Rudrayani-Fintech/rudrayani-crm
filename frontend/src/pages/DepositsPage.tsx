import {
  Button,
  DatePicker,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { CheckOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Company } from "../types";

const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

type DepositRow = {
  id: string;
  amount: string;
  mode: string | null;
  paid_at: string;
  deposited_at: string | null;
  customer_name: string;
  loan_number: string;
  company_name: string;
  collected_by_name: string;
  deposited_by_name: string | null;
};

/**
 * Deposit reconciliation (Phase 5): field collections are "pending" until the
 * cash reaches the bank. Select rows and mark them deposited — the dashboard's
 * Deposited Metrics read from this.
 */
export default function DepositsPage() {
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [filter, setFilter] = useState<"pending" | "deposited" | "all">("pending");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [rows, setRows] = useState<DepositRow[]>([]);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [loading, setLoading] = useState(false);
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    api.get("/companies").then((res) => setCompanies(res.data.companies)).catch((err) => message.error(errorMessage(err)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { month: month.format("YYYY-MM") };
      if (filter !== "all") params.deposited = String(filter === "deposited");
      if (companyId) params.company_id = companyId;
      const res = await api.get("/payments/deposits", { params });
      setRows(res.data.payments);
      setSelected([]);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [month, filter, companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyMarkDeposited = async () => {
    setMarking(true);
    try {
      const res = await api.patch("/payments/mark-deposited", { payment_ids: selected });
      message.success(`${res.data.marked} payment(s) marked deposited`);
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setMarking(false);
    }
  };

  const markDeposited = () => {
    const total = rows
      .filter((r) => selected.includes(r.id))
      .reduce((sum, r) => sum + Number(r.amount), 0);
    // Cash reconciliation, not a data edit -- there's no "unmark" in this
    // UI, so a batch of the wrong rows stays wrong until someone finds it
    // directly in the database.
    Modal.confirm({
      title: `Mark ${selected.length} payment(s) deposited?`,
      content: `Total ${rupee.format(total)}. This confirms the cash reached the bank and cannot be undone from here.`,
      okText: "Mark deposited",
      onOk: applyMarkDeposited,
    });
  };

  const pendingTotal = rows
    .filter((r) => !r.deposited_at)
    .reduce((sum, r) => sum + Number(r.amount), 0);

  return (
    <div>
      <Typography.Title level={4}>Deposits</Typography.Title>
      <Typography.Paragraph type="secondary">
        Collections stay <Tag color="orange">Pending</Tag> until the cash is banked. Select
        payments and mark them deposited once reconciled.
      </Typography.Paragraph>

      <Space wrap style={{ marginBottom: 16 }}>
        <DatePicker
          picker="month"
          allowClear={false}
          value={month}
          onChange={(m) => m && setMonth(m)}
        />
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          options={[
            { value: "pending", label: "Pending" },
            { value: "deposited", label: "Deposited" },
            { value: "all", label: "All" },
          ]}
        />
        <Select
          style={{ width: 240 }}
          title="All companies" placeholder="All companies"
          allowClear
          value={companyId}
          onChange={(v) => setCompanyId(v ?? null)}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Button
          type="primary"
          icon={<CheckOutlined />}
          disabled={selected.length === 0}
          loading={marking}
          onClick={markDeposited}
        >
          Mark deposited ({selected.length})
        </Button>
        {filter !== "deposited" && (
          <Typography.Text type="secondary">
            Pending total: <span className="money">{rupee.format(pendingTotal)}</span>
          </Typography.Text>
        )}
      </Space>

      <Table<DepositRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        size="small"
        rowSelection={{
          selectedRowKeys: selected,
          onChange: setSelected,
          getCheckboxProps: (r) => ({ disabled: !!r.deposited_at }),
        }}
        columns={[
          { title: "Customer", dataIndex: "customer_name" },
          { title: "Loan", dataIndex: "loan_number" },
          { title: "Company", dataIndex: "company_name" },
          {
            title: "Amount",
            dataIndex: "amount",
            align: "right",
            render: (v: string) => <span className="money">{rupee.format(Number(v))}</span>,
          },
          { title: "Mode", dataIndex: "mode", render: (v) => v ?? "—" },
          {
            title: "Collected",
            dataIndex: "paid_at",
            render: (v: string, r) => `${dayjs(v).format("DD MMM")} · ${r.collected_by_name}`,
          },
          {
            title: "Status",
            render: (_, r) =>
              r.deposited_at ? (
                <Tag color="green">
                  Deposited {dayjs(r.deposited_at).format("DD MMM")}
                  {r.deposited_by_name ? ` · ${r.deposited_by_name}` : ""}
                </Tag>
              ) : (
                <Tag color="orange">Pending</Tag>
              ),
          },
        ]}
        pagination={{ pageSize: 50 }}
      />
    </div>
  );
}
