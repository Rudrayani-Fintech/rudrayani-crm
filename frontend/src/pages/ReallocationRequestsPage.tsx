import { Alert, Badge, Button, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { CheckOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { palette } from "../theme/tokens";
import { rupees as fmtAmount } from "../utils/money";
import type { Employee, ReallocationRequest, ReallocationStatus } from "../types";

dayjs.extend(relativeTime);

const STATUS_TAG: Record<ReallocationStatus, { color: string; label: string }> = {
  pending: { color: "gold", label: "Pending" },
  approved: { color: "green", label: "Approved" },
  rejected: { color: "red", label: "Rejected" },
};

/**
 * Reallocation approvals (build brief §8): an agent flags a customer they
 * can't work (wrong area, language, dispute) from the mobile app; anyone
 * with customers.allocate decides here -- reassign to a named agent, return
 * to the unallocated pool, or reject the request outright.
 */
export default function ReallocationRequestsPage() {
  const [status, setStatus] = useState<ReallocationStatus>("pending");
  const [requests, setRequests] = useState<ReallocationRequest[]>([]);
  const [agents, setAgents] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [approveTarget, setApproveTarget] = useState<ReallocationRequest | null>(null);
  const [newAgentId, setNewAgentId] = useState<string | undefined>(undefined);
  const [rejectTarget, setRejectTarget] = useState<ReallocationRequest | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkApproveOpen, setBulkApproveOpen] = useState(false);
  const [bulkAgentId, setBulkAgentId] = useState<string | undefined>(undefined);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  useEffect(() => {
    api.get("/employees").then((res) => {
      setAgents(
        (res.data.employees as Employee[]).filter(
          (e) => e.is_active && e.capabilities.some((c) => ["telecaller", "field_agent"].includes(c)),
        ),
      );
    }).catch((err) => message.error(errorMessage(err)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/reallocation-requests", { params: { status } });
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
  // pendingCount for free from that same response, so firing this too on
  // every load() was a guaranteed extra request for no new information.
  useEffect(() => {
    if (status === "pending") return;
    api
      .get("/reallocation-requests", { params: { status: "pending" } })
      .then((res) => setPendingCount(res.data.total))
      .catch((err) => message.error(errorMessage(err)));
  }, [status, requests]);

  const decide = async (id: string, approve: boolean, opts?: { new_agent_id?: string; note?: string }) => {
    try {
      await api.post(`/reallocation-requests/${id}/decide`, { approve, ...opts });
      message.success(approve ? "Approved" : "Rejected");
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  // Mirrors Import Review's bulk-decision UX: one modal action for the
  // whole selection instead of clicking Approve/Reject once per row.
  const bulkDecide = async (approve: boolean, newAgentId?: string) => {
    setBulkSubmitting(true);
    try {
      const res = await api.post("/reallocation-requests/bulk-decide", {
        ids: selectedIds,
        approve,
        new_agent_id: newAgentId,
      });
      if (res.data.skipped.length > 0) {
        message.warning(
          `${res.data.applied.length} applied, ${res.data.skipped.length} skipped (already decided or stale)`,
        );
      } else {
        message.success(approve ? "Approved" : "Rejected");
      }
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setBulkSubmitting(false);
    }
  };

  return (
    <div>
      <Typography.Title level={4}>
        Reallocation Approvals{" "}
        <Badge count={pendingCount} showZero={false} style={{ backgroundColor: palette.warning }} />
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        An agent flags a customer they can&apos;t work (wrong area, language mismatch, a dispute) from
        the mobile app. Nothing changes until you decide here -- reassign to a named agent, return the
        customer to the unallocated pool, or reject the request.
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
          type="info"
          style={{ marginBottom: 12 }}
          message={
            <Space wrap>
              <span>
                <b>{selectedIds.length}</b> selected
              </span>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => {
                  setBulkAgentId(undefined);
                  setBulkApproveOpen(true);
                }}
              >
                Approve Selected
              </Button>
              <Button
                danger
                icon={<CloseOutlined />}
                loading={bulkSubmitting}
                onClick={() =>
                  Modal.confirm({
                    title: `Reject ${selectedIds.length} request(s)?`,
                    content: "Each customer stays with their current agent.",
                    okText: "Reject",
                    okButtonProps: { danger: true },
                    onOk: () => bulkDecide(false),
                  })
                }
              >
                Reject Selected
              </Button>
            </Space>
          }
        />
      )}

      <Table<ReallocationRequest>
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
        scroll={{ x: status !== "pending" ? 1500 : 1230 }}
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
          { title: "Requested By", dataIndex: "requested_by_name", width: 150, ellipsis: true },
          { title: "Reason", dataIndex: "reason", width: 200, ellipsis: true },
          {
            title: "Age",
            width: 110,
            render: (_, r) => dayjs(r.created_at).fromNow(),
          },
          ...(status !== "pending"
            ? [
                {
                  title: "Status",
                  width: 110,
                  render: (_: unknown, r: ReallocationRequest) => (
                    <Tag color={STATUS_TAG[r.status].color}>{STATUS_TAG[r.status].label}</Tag>
                  ),
                },
                {
                  title: "Decided",
                  width: 160,
                  render: (_: unknown, r: ReallocationRequest) =>
                    r.decided_at
                      ? `${dayjs(r.decided_at).fromNow()} by ${r.decided_by_name ?? "-"}`
                      : "-",
                },
              ]
            : []),
          {
            title: "Actions",
            width: 200,
            render: (_, r) =>
              r.status === "pending" ? (
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    icon={<CheckOutlined />}
                    onClick={() => {
                      setNewAgentId(undefined);
                      setApproveTarget(r);
                    }}
                  >
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
        title={`Approve reallocation for ${approveTarget?.customer_name ?? ""}?`}
        open={!!approveTarget}
        onCancel={() => setApproveTarget(null)}
        onOk={async () => {
          if (!approveTarget) return;
          await decide(approveTarget.id, true, { new_agent_id: newAgentId });
          setApproveTarget(null);
        }}
        okText="Approve"
      >
        <Typography.Paragraph type="secondary">
          Choose a new agent to reassign this customer, or leave blank to return it to the unallocated
          pool for a manager to pick up later.
        </Typography.Paragraph>
        <Select
          style={{ width: "100%" }}
          title="Return to unallocated pool" placeholder="Return to unallocated pool"
          allowClear
          value={newAgentId}
          onChange={(v) => setNewAgentId(v ?? undefined)}
          options={agents.map((a) => ({ value: a.id, label: a.full_name }))}
        />
      </Modal>

      <Modal
        title={`Approve ${selectedIds.length} reallocation request(s)?`}
        open={bulkApproveOpen}
        onCancel={() => setBulkApproveOpen(false)}
        confirmLoading={bulkSubmitting}
        onOk={async () => {
          await bulkDecide(true, bulkAgentId);
          setBulkApproveOpen(false);
        }}
        okText="Approve"
      >
        <Typography.Paragraph type="secondary">
          Reassign every selected customer to one agent, or leave blank to return all of them to the
          unallocated pool.
        </Typography.Paragraph>
        <Select
          style={{ width: "100%" }}
          title="Return to unallocated pool" placeholder="Return to unallocated pool"
          allowClear
          value={bulkAgentId}
          onChange={(v) => setBulkAgentId(v ?? undefined)}
          options={agents.map((a) => ({ value: a.id, label: a.full_name }))}
        />
      </Modal>

      <Modal
        title={`Reject reallocation request for ${rejectTarget?.customer_name ?? ""}?`}
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
          The customer stays with their current agent. Use this when the request doesn&apos;t hold up
          (e.g. the same area is already understaffed).
        </Typography.Paragraph>
      </Modal>

      {requests.length === 0 && !loading && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message={status === "pending" ? "No pending reallocation requests." : `No ${status} requests.`}
        />
      )}
    </div>
  );
}
