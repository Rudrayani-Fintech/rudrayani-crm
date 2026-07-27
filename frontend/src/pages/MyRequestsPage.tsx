import { Alert, Button, Select, Space, Table, Tag, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { ReallocationRequest, ReallocationStatus } from "../types";

dayjs.extend(relativeTime);

type StatusFilter = ReallocationStatus | "all";

const fmtAmount = (v: string | number | null | undefined) =>
  v == null ? "-" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const STATUS_TAG: Record<ReallocationStatus, { color: string; label: string }> = {
  pending: { color: "gold", label: "Pending" },
  approved: { color: "green", label: "Approved" },
  rejected: { color: "red", label: "Rejected" },
};

/**
 * "What happened to the reallocation requests I submitted?" -- an agent
 * previously had no way to check this anywhere (mobile or web). Reuses the
 * same GET /reallocation-requests the TL approval queue uses, self-scoped
 * server-side to the caller's own submissions.
 *
 * TODO: add a second tab here for correction-requests once that
 * workstream's self-scoped GET is wired up the same way.
 */
export default function MyRequestsPage() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [requests, setRequests] = useState<ReallocationRequest[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/reallocation-requests", { params: { status } });
      setRequests(res.data.requests);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <Typography.Title level={4}>My Requests</Typography.Title>
      <Typography.Paragraph type="secondary">
        Reallocation requests you&apos;ve submitted, and their status. A team lead or ops decides these
        -- this is just for you to check where things stand.
      </Typography.Paragraph>

      <Space style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 160 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All" },
            { value: "pending", label: "Pending" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          Refresh
        </Button>
      </Space>

      <Table<ReallocationRequest>
        rowKey="id"
        loading={loading}
        dataSource={requests}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 1350 }}
        columns={[
          {
            title: "Loan Number",
            dataIndex: "loan_number",
            width: 140,
            render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
          },
          { title: "Customer", dataIndex: "customer_name", width: 160, ellipsis: true },
          { title: "Company", dataIndex: "company_name", width: 150, ellipsis: true },
          {
            title: "Due Amount",
            dataIndex: "due_amount",
            width: 120,
            align: "right" as const,
            render: (v: string | null) => <span className="money">{fmtAmount(v)}</span>,
          },
          { title: "Reason", dataIndex: "reason", width: 200, ellipsis: true },
          {
            title: "Status",
            width: 110,
            render: (_, r) => {
              const tag = STATUS_TAG[r.status] ?? { color: "default", label: r.status };
              return <Tag color={tag.color}>{tag.label}</Tag>;
            },
          },
          {
            title: "Age",
            width: 110,
            render: (_, r) => dayjs(r.created_at).fromNow(),
          },
          {
            title: "Decision",
            width: 220,
            render: (_, r) =>
              r.status === "pending" ? (
                <Typography.Text type="secondary">Awaiting decision</Typography.Text>
              ) : (
                <span>
                  {r.decided_at ? dayjs(r.decided_at).fromNow() : "-"}
                  {r.decision_note && (
                    <>
                      <br />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {r.decision_note}
                      </Typography.Text>
                    </>
                  )}
                </span>
              ),
          },
        ]}
      />

      {requests.length === 0 && !loading && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message="You haven't submitted any reallocation requests yet."
        />
      )}
    </div>
  );
}
