import { Alert, Badge, Button, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { CheckOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { palette } from "../theme/tokens";

dayjs.extend(relativeTime);

type CorrectionStatus = "pending" | "approved" | "rejected";

interface CorrectionRequest {
  id: string;
  record_type: "payment" | "call_log" | "ptp";
  record_id: string;
  reason: string;
  proposed_changes: Record<string, string | number>;
  status: CorrectionStatus;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  requested_by_id: string;
  requested_by_name: string;
  decided_by_name: string | null;
  customer_id: string | null;
  loan_number: string | null;
  customer_name: string | null;
}

const STATUS_TAG: Record<CorrectionStatus, { color: string; label: string }> = {
  pending: { color: "gold", label: "Pending" },
  approved: { color: "green", label: "Approved" },
  rejected: { color: "red", label: "Rejected" },
};

const RECORD_TYPE_LABEL: Record<CorrectionRequest["record_type"], string> = {
  payment: "Payment",
  call_log: "Call Log",
  ptp: "PTP",
};

function formatChanges(changes: Record<string, string | number>): string {
  return Object.entries(changes)
    .map(([k, v]) => `${k} → ${v}`)
    .join(", ");
}

/**
 * Correction-request approvals (MVP hardening): an agent flags a mistaken
 * payment amount, a garbled call-log remark, or a wrong PTP date/amount on
 * their own record. Nothing changes until a TL/ops decides here.
 */
export default function CorrectionRequestsPage() {
  const [status, setStatus] = useState<CorrectionStatus>("pending");
  const [requests, setRequests] = useState<CorrectionRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [approveTarget, setApproveTarget] = useState<CorrectionRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<CorrectionRequest | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkRejecting, setBulkRejecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/correction-requests", { params: { status } });
      setRequests(res.data.requests);
      setSelectedIds([]);
      if (status === "pending") setPendingCount(res.data.total);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  // Skipped while already viewing "pending" -- load() above sets
  // pendingCount for free from that same response (see the `if (status ===
  // "pending")` line), so firing this too on every load() was a guaranteed
  // extra request for no new information.
  useEffect(() => {
    if (status === "pending") return;
    api.get("/correction-requests", { params: { status: "pending" } })
      .then((res) => setPendingCount(res.data.total))
      .catch((err) => message.error(errorMessage(err)));
  }, [status, requests]);

  const decide = async (id: string, approve: boolean, note?: string) => {
    try {
      await api.post(`/correction-requests/${id}/decide`, { approve, note });
      message.success(approve ? "Approved — the record has been updated" : "Rejected");
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  // Bulk approve is deliberately not offered here: unlike a reallocation
  // (one decision applied uniformly), every correction proposes a different
  // field change on a different record -- approving a batch of unreviewed
  // edits sight-unseen is a real risk. Bulk reject carries no such risk, so
  // it's the one bulk action offered.
  const bulkReject = async () => {
    setBulkRejecting(true);
    try {
      const res = await api.post("/correction-requests/bulk-decide", { ids: selectedIds, approve: false });
      if (res.data.skipped.length > 0) {
        message.warning(
          `${res.data.applied.length} rejected, ${res.data.skipped.length} skipped (already decided or stale)`,
        );
      } else {
        message.success("Rejected");
      }
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setBulkRejecting(false);
    }
  };

  return (
    <div>
      <Typography.Title level={4}>
        Correction Requests{" "}
        <Badge count={pendingCount} showZero={false} style={{ backgroundColor: palette.warning }} />
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        An agent flags a mistake on their own payment, call log, or PTP. Nothing changes until you
        approve here — the original value is preserved either way.
      </Typography.Paragraph>

      <Space style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 160 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: "pending", label: "Pending" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          Refresh
        </Button>
      </Space>

      {status === "pending" && selectedIds.length > 0 && (
        <Alert
          type="warning"
          style={{ marginBottom: 12 }}
          message={
            <Space wrap>
              <span>
                <b>{selectedIds.length}</b> selected
              </span>
              <Button
                danger
                icon={<CloseOutlined />}
                loading={bulkRejecting}
                onClick={() =>
                  Modal.confirm({
                    title: `Reject ${selectedIds.length} correction request(s)?`,
                    content: "The original records stay exactly as they are.",
                    okText: "Reject",
                    okButtonProps: { danger: true },
                    onOk: bulkReject,
                  })
                }
              >
                Reject Selected
              </Button>
            </Space>
          }
        />
      )}

      <Table<CorrectionRequest>
        rowKey="id"
        loading={loading}
        dataSource={requests}
        rowSelection={
          status === "pending"
            ? {
                selectedRowKeys: selectedIds,
                onChange: (keys) => setSelectedIds(keys as string[]),
                getCheckboxProps: (r) => ({ disabled: r.status !== "pending" }),
              }
            : undefined
        }
        pagination={{ pageSize: 20 }}
        scroll={{ x: status !== "pending" ? 1490 : 1230 }}
        columns={[
          {
            title: "Type",
            dataIndex: "record_type",
            width: 100,
            render: (v: CorrectionRequest["record_type"]) => <Tag>{RECORD_TYPE_LABEL[v]}</Tag>,
          },
          {
            title: "Loan Number",
            dataIndex: "loan_number",
            width: 140,
            render: (v: string | null) =>
              v ? <Typography.Text code>{v}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>,
          },
          { title: "Customer", dataIndex: "customer_name", width: 160, ellipsis: true, render: (v: string | null) => v ?? "-" },
          { title: "Requested By", dataIndex: "requested_by_name", width: 150, ellipsis: true },
          { title: "Proposed Change", width: 200, render: (_, r) => formatChanges(r.proposed_changes) },
          { title: "Reason", dataIndex: "reason", width: 200, ellipsis: true },
          {
            title: "Age",
            width: 100,
            render: (_, r) => dayjs(r.created_at).fromNow(),
          },
          ...(status !== "pending"
            ? [
                {
                  title: "Status",
                  width: 100,
                  render: (_: unknown, r: CorrectionRequest) => (
                    <Tag color={STATUS_TAG[r.status].color}>{STATUS_TAG[r.status].label}</Tag>
                  ),
                },
                {
                  title: "Decided",
                  width: 160,
                  render: (_: unknown, r: CorrectionRequest) =>
                    r.decided_at ? `${dayjs(r.decided_at).fromNow()} by ${r.decided_by_name ?? "-"}` : "-",
                },
              ]
            : []),
          {
            title: "Actions",
            width: 180,
            render: (_, r) =>
              r.status === "pending" ? (
                <Space>
                  <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => setApproveTarget(r)}>
                    Approve
                  </Button>
                  <Button size="small" danger icon={<CloseOutlined />} onClick={() => setRejectTarget(r)}>
                    Reject
                  </Button>
                </Space>
              ) : (
                <Typography.Text type="secondary">{r.decision_note ?? "-"}</Typography.Text>
              ),
          },
        ]}
      />

      <Modal
        title={`Approve this correction?`}
        open={!!approveTarget}
        onCancel={() => setApproveTarget(null)}
        onOk={async () => {
          if (!approveTarget) return;
          await decide(approveTarget.id, true);
          setApproveTarget(null);
        }}
        okText="Approve"
      >
        {approveTarget && (
          <Typography.Paragraph>
            <b>{RECORD_TYPE_LABEL[approveTarget.record_type]}</b> for{" "}
            <b>{approveTarget.customer_name ?? "this customer"}</b> will change:{" "}
            <Typography.Text code>{formatChanges(approveTarget.proposed_changes)}</Typography.Text>
          </Typography.Paragraph>
        )}
      </Modal>

      <Modal
        title="Reject this correction request?"
        open={!!rejectTarget}
        onCancel={() => setRejectTarget(null)}
        onOk={async () => {
          if (!rejectTarget) return;
          await decide(rejectTarget.id, false);
          setRejectTarget(null);
        }}
        okText="Reject"
        okButtonProps={{ danger: true }}
      >
        <Typography.Paragraph type="secondary">
          The original record stays exactly as it is. Use this if the requested change doesn&apos;t hold
          up (e.g. it doesn&apos;t match a call recording or payment slip).
        </Typography.Paragraph>
      </Modal>

      {requests.length === 0 && !loading && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message={status === "pending" ? "No pending correction requests." : `No ${status} requests.`}
        />
      )}
    </div>
  );
}
