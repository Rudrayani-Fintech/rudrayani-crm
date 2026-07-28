import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { CheckOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { palette } from "../theme/tokens";
import { rupees as fmtAmount } from "../utils/money";
import type { Company, ReviewItem, ReviewItemType } from "../types";

dayjs.extend(relativeTime);

const TYPE_TAG: Record<ReviewItemType, { color: string; label: string }> = {
  addition: { color: "blue", label: "Addition" },
  removal: { color: "red", label: "Removal" },
  reactivation: { color: "orange", label: "Reactivation" },
  update: { color: "gold", label: "Update" },
};

interface ItemDetail {
  item: ReviewItem;
  context: {
    customer?: Record<string, unknown> | null;
    last_call?: { remark: string | null; created_at: string } | null;
    pending_ptp?: { amount: string; promised_date: string } | null;
    paid_this_month?: string | number;
  };
}

/**
 * Discrepancy review queue (Phase 7): additions/removals/reactivations
 * detected by a repeat/refresh allocation import (allocation files can
 * arrive at any point in the month, not just once) wait here for an agency
 * admin/operations manager to decide -- nothing applies without a decision.
 */
export default function ImportReviewPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("pending");
  const [type, setType] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedDetail, setExpandedDetail] = useState<Record<string, ItemDetail>>({});
  const [rejectTarget, setRejectTarget] = useState<{ ids: string[] } | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    api.get("/companies").then((res) => {
      setCompanies(res.data.companies);
      if (res.data.companies.length > 0) setCompanyId(res.data.companies[0].id);
    }).catch((err) => message.error(errorMessage(err)));
  }, []);

  const load = useCallback(async () => {
    if (!companyId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get("/import-reviews", {
        params: { company_id: companyId, status, type, limit: 200 },
      });
      setItems(res.data.items);
      setSelectedIds([]);
      if (status === "pending") setPendingCount(res.data.total);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [companyId, status, type]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the pending badge accurate even when viewing a different status/type
  // filter. Skipped entirely while already viewing "pending" -- load() above
  // sets pendingCount for free from that same response, so firing this too
  // on every load() was a guaranteed extra request for no new information.
  useEffect(() => {
    if (!companyId || status === "pending") return;
    api
      .get("/import-reviews", { params: { company_id: companyId, status: "pending", limit: 1 } })
      .then((res) => setPendingCount(res.data.total))
      .catch((err) => message.error(errorMessage(err)));
  }, [companyId, status, items]);

  const loadDetail = async (id: string) => {
    if (expandedDetail[id]) return;
    try {
      const res = await api.get(`/import-reviews/${id}`);
      setExpandedDetail((prev) => ({ ...prev, [id]: res.data }));
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const decide = async (ids: string[], action: "approve" | "reject", note?: string) => {
    try {
      if (ids.length === 1) {
        await api.post(`/import-reviews/${ids[0]}/decision`, { action, note });
      } else {
        const res = await api.post("/import-reviews/bulk-decision", { ids, action, note });
        if (res.data.skipped.length > 0) {
          message.warning(
            `${res.data.applied.length} applied, ${res.data.skipped.length} skipped (already decided or stale)`,
          );
        }
      }
      message.success(action === "approve" ? "Approved" : "Rejected");
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const confirmApprove = (ids: string[]) => {
    Modal.confirm({
      title: `Approve ${ids.length} item${ids.length > 1 ? "s" : ""}?`,
      content:
        "Additions insert the customer, removals mark them recalled, reactivations restore them to active.",
      okText: "Approve",
      onOk: () => decide(ids, "approve"),
    });
  };

  const openReject = (ids: string[]) => {
    setRejectNote("");
    setRejectTarget({ ids });
  };

  const pendingSelected = items
    .filter((i) => selectedIds.includes(i.id) && i.status === "pending")
    .map((i) => i.id);

  return (
    <div>
      <Typography.Title level={4}>
        Import Review{" "}
        <Badge count={pendingCount} showZero={false} style={{ backgroundColor: palette.warning }} />
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        A repeat allocation import for a month you've already loaded (allocation files can arrive at
        any time, not just once a month) is diffed against the active book. New loans, loans that
        reappear after being recalled/closed, and active loans missing from the file all wait here
        for a decision -- nothing changes until you approve or reject it.
      </Typography.Paragraph>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ width: 260 }}
          title="Select company" placeholder="Select company"
          value={companyId}
          onChange={setCompanyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          style={{ width: 160 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: "pending", label: "Pending" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
            { value: "superseded", label: "Superseded" },
            { value: "all", label: "All" },
          ]}
        />
        <Select
          style={{ width: 160 }}
          title="All types" placeholder="All types"
          allowClear
          value={type}
          onChange={setType}
          options={[
            { value: "addition", label: "Addition" },
            { value: "removal", label: "Removal" },
            { value: "reactivation", label: "Reactivation" },
            { value: "update", label: "Update" },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          Refresh
        </Button>
      </Space>

      {pendingSelected.length > 0 && (
        <Space style={{ marginBottom: 12 }}>
          <Typography.Text>{pendingSelected.length} selected</Typography.Text>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={() => confirmApprove(pendingSelected)}
          >
            Approve Selected
          </Button>
          <Button danger icon={<CloseOutlined />} onClick={() => openReject(pendingSelected)}>
            Reject Selected
          </Button>
        </Space>
      )}

      <Table<ReviewItem>
        rowKey="id"
        loading={loading}
        dataSource={items}
        locale={{
          // An empty queue here is a good sign, not a setup gap -- no
          // discrepancy was detected on the latest import, or everything
          // already got a decision. Previously a bare "No Data".
          emptyText: (
            <Empty
              description={
                status === "pending"
                  ? "No pending items — nothing needs a decision right now"
                  : `No ${status} items for this company`
              }
            />
          ),
        }}
        pagination={{ pageSize: 20 }}
        scroll={{ x: "max-content" }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
          getCheckboxProps: (record) => ({ disabled: record.status !== "pending" }),
        }}
        expandable={{
          onExpand: (expanded, record) => {
            if (expanded) void loadDetail(record.id);
          },
          expandedRowRender: (record) => {
            const detail = expandedDetail[record.id];
            const p = record.payload;
            const isUpdate = record.item_type === "update";
            // For an update item, show what actually changes -- a bucket/amount
            // that matches the current value isn't worth a reviewer's attention.
            const bucketChanged = isUpdate && p.bucket != null && p.bucket !== record.current_bucket;
            const dueChanged =
              isUpdate && p.due_amount != null && String(p.due_amount) !== String(record.current_due_amount);
            return (
              <Descriptions size="small" bordered column={1}>
                <Descriptions.Item label="Customer name">{p.customer_name ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Mobile">{p.mobile_number ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Product">{p.product ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="Bucket">
                  {isUpdate && bucketChanged ? (
                    <>
                      {record.current_bucket ?? "-"} <Typography.Text type="secondary">→</Typography.Text>{" "}
                      <Typography.Text strong>{p.bucket}</Typography.Text>
                    </>
                  ) : (
                    p.bucket ?? "-"
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="Due amount">
                  {isUpdate && dueChanged ? (
                    <>
                      {fmtAmount(record.current_due_amount)}{" "}
                      <Typography.Text type="secondary">→</Typography.Text>{" "}
                      <Typography.Text strong>{fmtAmount(p.due_amount)}</Typography.Text>
                    </>
                  ) : (
                    fmtAmount(p.due_amount)
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="EMI">{fmtAmount(p.emi)}</Descriptions.Item>
                <Descriptions.Item label="Agent phone">{p.agent_phone ?? "-"}</Descriptions.Item>
                {p.custom_fields && Object.keys(p.custom_fields).length > 0
                  ? Object.entries(p.custom_fields).map(([k, v]) => (
                      <Descriptions.Item key={k} label={k}>
                        {v ? String(v) : "-"}
                      </Descriptions.Item>
                    ))
                  : <Descriptions.Item label="Custom fields">-</Descriptions.Item>}
                {record.item_type !== "addition" && (
                  <>
                    <Descriptions.Item label="Last call" span={2}>
                      {detail?.context.last_call
                        ? `${detail.context.last_call.remark ?? "(no remark)"} — ${dayjs(detail.context.last_call.created_at).fromNow()}`
                        : detail
                          ? "No call history"
                          : "Loading…"}
                    </Descriptions.Item>
                    <Descriptions.Item label="Pending PTP" span={2}>
                      {detail?.context.pending_ptp
                        ? `${fmtAmount(detail.context.pending_ptp.amount)} by ${dayjs(detail.context.pending_ptp.promised_date).format("DD MMM YYYY")}`
                        : detail
                          ? "None"
                          : "Loading…"}
                    </Descriptions.Item>
                    <Descriptions.Item label="Paid this month" span={2}>
                      {detail ? fmtAmount(detail.context.paid_this_month ?? 0) : "Loading…"}
                    </Descriptions.Item>
                  </>
                )}
                {record.review_note && (
                  <Descriptions.Item label="Review note" span={2}>
                    {record.review_note}
                  </Descriptions.Item>
                )}
              </Descriptions>
            );
          },
        }}
        columns={[
          {
            title: "Type",
            dataIndex: "item_type",
            width: 120,
            render: (v: ReviewItemType) => {
              const tag = TYPE_TAG[v] ?? { color: "default", label: v };
              return <Tag color={tag.color}>{tag.label}</Tag>;
            },
          },
          {
            title: "Loan Number",
            dataIndex: "loan_number",
            render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
          },
          {
            title: "Customer",
            render: (_, r) => r.payload.customer_name ?? r.current_customer_name ?? "-",
          },
          {
            title: "Bucket",
            width: 90,
            render: (_, r) => r.payload.bucket ?? r.current_bucket ?? "-",
          },
          {
            title: "Due Amount",
            width: 120,
            align: "right" as const,
            render: (_, r) => (
              <span className="money">{fmtAmount(r.payload.due_amount ?? r.current_due_amount)}</span>
            ),
          },
          {
            title: "Agent",
            width: 140,
            ellipsis: true,
            render: (_, r) => r.current_agent_name ?? "-",
          },
          {
            title: "Source",
            width: 180,
            render: (_, r) => (
              <span>
                {r.file_name ?? "-"}
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {r.allocation_month ? dayjs(r.allocation_month).format("MMM YYYY") : "-"}
                </Typography.Text>
              </span>
            ),
          },
          {
            title: "Age",
            width: 110,
            render: (_, r) => dayjs(r.created_at).fromNow(),
          },
          ...(status === "all" || status !== "pending"
            ? [
                {
                  title: "Status",
                  width: 110,
                  render: (_: unknown, r: ReviewItem) => {
                    const color =
                      r.status === "approved" ? "green" : r.status === "rejected" ? "red" : "default";
                    return <Tag color={color}>{r.status}</Tag>;
                  },
                },
              ]
            : []),
          {
            title: "Actions",
            width: 160,
            render: (_, r) =>
              r.status === "pending" ? (
                <Space>
                  <Button size="small" type="primary" onClick={() => confirmApprove([r.id])}>
                    Approve
                  </Button>
                  <Button size="small" danger onClick={() => openReject([r.id])}>
                    Reject
                  </Button>
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {r.reviewed_at ? dayjs(r.reviewed_at).fromNow() : "-"}
                </Typography.Text>
              ),
          },
        ]}
      />

      <Modal
        title={`Reject ${rejectTarget?.ids.length ?? 0} item${(rejectTarget?.ids.length ?? 0) > 1 ? "s" : ""}?`}
        open={!!rejectTarget}
        onCancel={() => setRejectTarget(null)}
        onOk={async () => {
          if (!rejectTarget) return;
          await decide(rejectTarget.ids, "reject", rejectNote.trim() || undefined);
          setRejectTarget(null);
        }}
        okText="Reject"
        okButtonProps={{ danger: true }}
      >
        <Input.TextArea
          rows={3}
          placeholder="Optional note (e.g. confirmed with the branch)"
          value={rejectNote}
          onChange={(e) => setRejectNote(e.target.value)}
        />
      </Modal>

      {!companyId && companies.length === 0 && (
        <Alert type="info" showIcon message="No companies yet — add one to start importing." />
      )}
    </div>
  );
}
