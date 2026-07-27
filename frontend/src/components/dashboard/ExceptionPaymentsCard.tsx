import { Card, DatePicker, Empty, Table, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { lakh } from "./format";
import type { DashboardFilters } from "./types";

const { RangePicker } = DatePicker;

interface ExceptionRow {
  id: string;
  amount: number;
  due_amount: number | null;
  mode: string | null;
  paid_at: string;
  customer_name: string;
  loan_number: string;
  company_name: string;
  collected_by_name: string;
}

/**
 * payments.exceeds_due_amount is written on every payment (the flag exists
 * specifically so someone could spot-check "why did this collection come in
 * higher than what's owed") but had no consumer anywhere in the app. This is
 * that consumer.
 */
export default function ExceptionPaymentsCard({ filters }: { filters: DashboardFilters }) {
  const monthStart = dayjs(`${filters.month}-01`);
  const [range, setRange] = useState<[Dayjs, Dayjs]>([monthStart.startOf("month"), monthStart.endOf("month")]);
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(false);

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
    for (const key of ["company_id", "branch_id", "team_id", "agent_id", "product", "bucket"] as const) {
      if (filters[key]) params[key] = filters[key]!;
    }
    api
      .get("/reports/exceptions", { params })
      .then((res) => {
        if (!cancelled) setRows(res.data.rows);
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

  return (
    <Card
      size="small"
      title="Payments Above Due Amount"
      extra={
        <RangePicker
          size="small"
          value={range}
          onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
          allowClear={false}
        />
      }
    >
      <Table<ExceptionRow>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
        locale={{ emptyText: <Empty description="No payments exceeded the due amount in this range" /> }}
        columns={[
          { title: "Loan No", dataIndex: "loan_number" },
          { title: "Customer", dataIndex: "customer_name" },
          { title: "Company", dataIndex: "company_name" },
          { title: "Collected By", dataIndex: "collected_by_name" },
          {
            title: "Paid",
            dataIndex: "paid_at",
            render: (v: string) => dayjs(v).format("DD MMM, HH:mm"),
          },
          {
            title: "Amount",
            dataIndex: "amount",
            align: "right",
            render: (v: number) => <span className="money">{lakh(v)}</span>,
          },
          {
            title: "Due",
            dataIndex: "due_amount",
            align: "right",
            render: (v: number | null) => (v != null ? <span className="money">{lakh(v)}</span> : "—"),
          },
        ]}
      />
      {rows.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Worth a second look — could be a legitimate settlement, or a data-entry slip.
        </Typography.Text>
      )}
    </Card>
  );
}
