import {
  Button,
  Descriptions,
  Drawer,
  Empty,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
  Upload,
  message,
} from "antd";
import {
  DownloadOutlined,
  EditOutlined,
  FilePdfOutlined,
  FileImageOutlined,
  FlagOutlined,
  PlusOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { UploadProps } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { rupees as fmtAmount } from "../utils/money";
import EditRemarkModal from "./EditRemarkModal";
import PtpFormModal, { type PtpRecord } from "./PtpFormModal";
import ReportCorrectionModal, { type CorrectableRecordType } from "./ReportCorrectionModal";

interface Attachment {
  id: string;
  kind: "photo" | "document";
  file_name: string;
  mime_type: string;
  size_bytes: number;
  note: string | null;
  created_at: string;
  uploaded_by_name: string;
}

interface CustomerDetail {
  customer: {
    id: string;
    loan_number: string;
    customer_name: string;
    mobile_number: string | null;
    product: string | null;
    bucket: string | null;
    due_amount: string | null;
    pos: string | null;
    emi: string | null;
    due_date: string | null;
    status: "active" | "closed" | "recalled";
    recalled_at: string | null;
    custom_fields: Record<string, string>;
    created_at: string;
  };
  company_name: string;
  detail_fields: string[];
  field_catalog: { field_key: string; label: string; is_required: boolean }[];
  trail: {
    id: string;
    remark: string | null;
    extra_remark: string | null;
    action_code: string | null;
    result_code: string | null;
    agent_id: string;
    agent_name: string | null;
    created_at: string;
    edited_at: string | null;
  }[];
  ptps: { id: string; amount: string; promised_date: string; status: string; mode: string | null }[];
  payments: { id: string; amount: string; mode: string | null; paid_at: string; deposited_at: string | null }[];
  bucket_movements: {
    id: string;
    from_bucket: string;
    to_bucket: string | null;
    trigger: "payment" | "allocation";
    month: string;
    detected_at: string;
  }[];
  allocation_history: {
    id: string;
    reason: string | null;
    created_at: string;
    from_agent_name: string | null;
    to_agent_name: string;
    allocated_by_name: string;
  }[];
  snapshots: { month: string; bucket: string | null; due_amount: string | null; emi: string | null; product: string | null }[];
}

const orDash = (v: string | null | undefined) => (v == null || v === "" ? "-" : v);

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  active: { color: "green", label: "Active" },
  closed: { color: "default", label: "Closed" },
  recalled: { color: "orange", label: "Recalled" },
};

export default function CustomerDetailDrawer({
  customerId,
  open,
  onClose,
}: {
  customerId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const { user } = useAuth();
  const [editRemarkTrailId, setEditRemarkTrailId] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [correctionTarget, setCorrectionTarget] = useState<{
    recordType: CorrectableRecordType;
    recordId: string;
    currentValues: Record<string, string | number | null>;
  } | null>(null);
  // undefined = modal closed; null = create mode; a PtpRecord = edit mode.
  const [ptpModalTarget, setPtpModalTarget] = useState<PtpRecord | null | undefined>(undefined);

  const loadDetail = useCallback(() => {
    if (!customerId) return;
    api
      .get(`/customers/${customerId}`)
      .then((res) => setDetail(res.data))
      .catch((err) => message.error(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [customerId]);

  useEffect(() => {
    if (!open || !customerId) return;
    setDetail(null);
    setLoading(true);
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customerId]);

  const loadAttachments = useCallback(() => {
    if (!customerId) return;
    setAttachmentsLoading(true);
    api
      .get("/attachments", { params: { customer_id: customerId } })
      .then((res) => setAttachments(res.data.attachments))
      .catch((err) => message.error(errorMessage(err)))
      .finally(() => setAttachmentsLoading(false));
  }, [customerId]);

  useEffect(() => {
    if (!open) return;
    loadAttachments();
  }, [open, loadAttachments]);

  const downloadAttachment = async (a: Attachment) => {
    try {
      const res = await api.get(`/attachments/${a.id}/file`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data as Blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.file_name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const uploadProps: UploadProps = {
    accept: "image/jpeg,image/png,image/webp,application/pdf",
    showUploadList: false,
    customRequest: async ({ file, onSuccess, onError }) => {
      const form = new FormData();
      form.append("customer_id", customerId ?? "");
      form.append("file", file as File);
      try {
        await api.post("/attachments", form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        message.success("Document uploaded");
        loadAttachments();
        onSuccess?.({});
      } catch (err) {
        message.error(errorMessage(err));
        onError?.(err as Error);
      }
    },
    beforeUpload: (file) => {
      if (file.size > 10 * 1024 * 1024) {
        message.error("File must be under 10 MB");
        return Upload.LIST_IGNORE;
      }
      return true;
    },
  };

  const currentMonth = dayjs().format("YYYY-MM-01");
  const normalizedPending =
    detail?.bucket_movements.some((m) => m.trigger === "payment" && m.month === currentMonth) ?? false;

  // Admin's Field Config "required" toggle only ever showed up on the Field
  // Config page itself -- agents/TLs viewing a customer had no way to tell
  // which fields the company actually requires. field_catalog (added to
  // GET /customers/:id) makes that visible here too.
  const requiredFieldKeys = new Set(
    (detail?.field_catalog ?? []).filter((f) => f.is_required).map((f) => f.field_key),
  );
  const fieldLabel = (label: string, fieldKey: string) => (
    <>
      {label}
      {requiredFieldKeys.has(fieldKey) && (
        <Tag color="red" style={{ marginLeft: 6, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>
          Required
        </Tag>
      )}
    </>
  );

  return (
    <Drawer
      title={detail ? `${detail.customer.customer_name} — ${detail.customer.loan_number}` : "Customer"}
      open={open}
      onClose={onClose}
      width={720}
    >
      {loading && (
        <div style={{ display: "grid", placeItems: "center", height: 200 }}>
          <Spin size="large" />
        </div>
      )}
      {!loading && detail && (
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <Space wrap>
            <Tag color={(STATUS_TAG[detail.customer.status] ?? { color: "default" }).color}>
              {(STATUS_TAG[detail.customer.status] ?? { label: detail.customer.status }).label}
            </Tag>
            {normalizedPending && (
              <Tag color="blue">Normalized this month (pending lender confirmation)</Tag>
            )}
            {detail.customer.recalled_at && (
              <Typography.Text type="secondary">
                Recalled {dayjs(detail.customer.recalled_at).format("DD MMM YYYY")}
              </Typography.Text>
            )}
          </Space>

          <div>
            <Typography.Title level={5}>Identity</Typography.Title>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="Company">{detail.company_name}</Descriptions.Item>
              <Descriptions.Item label={fieldLabel("Mobile", "mobile_number")}>
                {orDash(detail.customer.mobile_number)}
              </Descriptions.Item>
              <Descriptions.Item label={fieldLabel("Product", "product")}>
                {orDash(detail.customer.product)}
              </Descriptions.Item>
              <Descriptions.Item label={fieldLabel("Bucket", "bucket")}>
                {orDash(detail.customer.bucket)}
              </Descriptions.Item>
              <Descriptions.Item label={fieldLabel("Due Amount", "due_amount")}>
                {fmtAmount(detail.customer.due_amount)}
              </Descriptions.Item>
              <Descriptions.Item label={fieldLabel("POS", "pos")}>
                {fmtAmount(detail.customer.pos)}
              </Descriptions.Item>
              <Descriptions.Item label={fieldLabel("EMI", "emi")}>
                {fmtAmount(detail.customer.emi)}
              </Descriptions.Item>
              <Descriptions.Item label={fieldLabel("EMI Due Date", "emi_due_date")}>
                {detail.customer.due_date ? dayjs(detail.customer.due_date).format("DD MMM YYYY") : "-"}
              </Descriptions.Item>
              <Descriptions.Item label="DPD (from due date)">
                {detail.customer.due_date
                  ? Math.max(dayjs().diff(dayjs(detail.customer.due_date), "day"), 0)
                  : "-"}
              </Descriptions.Item>
              {Object.entries(detail.customer.custom_fields).map(([field, value]) => (
                <Descriptions.Item key={field} label={fieldLabel(field, field)}>
                  {orDash(value)}
                </Descriptions.Item>
              ))}
            </Descriptions>
          </div>

          <div>
            <Typography.Title level={5}>Trail History</Typography.Title>
            {detail.trail.length === 0 ? (
              <Empty description="No calls logged yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Timeline
                items={detail.trail.map((t) => ({
                  children: (
                    <>
                      <Typography.Text strong>
                        {orDash(t.action_code)} / {orDash(t.result_code)}
                      </Typography.Text>{" "}
                      <Typography.Text type="secondary">
                        {dayjs(t.created_at).format("DD MMM YYYY, HH:mm")} — {orDash(t.agent_name)}
                      </Typography.Text>
                      <div>
                        {orDash(t.remark)}{" "}
                        {t.edited_at && (
                          <Tag color="default" style={{ fontSize: 11 }}>
                            edited {dayjs(t.edited_at).format("DD MMM, HH:mm")}
                          </Tag>
                        )}
                        {t.agent_id === user?.id && dayjs().diff(dayjs(t.created_at), "hour", true) < 24 ? (
                          <Button
                            size="small"
                            type="link"
                            style={{ padding: 0, height: "auto" }}
                            onClick={() => setEditRemarkTrailId(t.id)}
                          >
                            Edit
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            type="link"
                            style={{ padding: 0, height: "auto" }}
                            onClick={() =>
                              setCorrectionTarget({
                                recordType: "call_log",
                                recordId: t.id,
                                currentValues: { remark: t.remark },
                              })
                            }
                          >
                            Report an error
                          </Button>
                        )}
                      </div>
                    </>
                  ),
                }))}
              />
            )}
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                Promises to Pay
              </Typography.Title>
              {/* Previously the only way a PTP could exist was as a side
                  effect of logging a call with a PTP-flavored disposition --
                  there was no first-class way to record one directly. */}
              <Button size="small" icon={<PlusOutlined />} onClick={() => setPtpModalTarget(null)}>
                New PTP
              </Button>
            </div>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={detail.ptps}
              locale={{ emptyText: "No PTPs" }}
              columns={[
                { title: "Amount", dataIndex: "amount", render: fmtAmount },
                {
                  title: "Promised Date",
                  dataIndex: "promised_date",
                  render: (v: string) => dayjs(v).format("DD MMM YYYY"),
                },
                {
                  title: "Status",
                  dataIndex: "status",
                  render: (v: string) => (
                    <Tag color={v === "kept" ? "green" : v === "broken" ? "red" : "gold"}>{v}</Tag>
                  ),
                },
                {
                  title: "",
                  key: "actions",
                  width: 70,
                  render: (_: unknown, row: CustomerDetail["ptps"][number]) => (
                    <Space size={0}>
                      {row.status === "pending" && (
                        <Button
                          size="small"
                          type="text"
                          icon={<EditOutlined />}
                          title="Reschedule / mark kept or broken"
                          onClick={() => setPtpModalTarget(row)}
                        />
                      )}
                      <Button
                        size="small"
                        type="text"
                        icon={<FlagOutlined />}
                        title="Report an error"
                        onClick={() =>
                          setCorrectionTarget({
                            recordType: "ptp",
                            recordId: row.id,
                            currentValues: { amount: row.amount, promised_date: row.promised_date },
                          })
                        }
                      />
                    </Space>
                  ),
                },
              ]}
            />
          </div>

          <div>
            <Typography.Title level={5}>Payments</Typography.Title>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={detail.payments}
              locale={{ emptyText: "No payments recorded" }}
              columns={[
                { title: "Amount", dataIndex: "amount", render: fmtAmount },
                { title: "Mode", dataIndex: "mode", render: orDash },
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
                {
                  title: "",
                  key: "actions",
                  width: 40,
                  render: (_: unknown, row: CustomerDetail["payments"][number]) => (
                    <Button
                      size="small"
                      type="text"
                      icon={<FlagOutlined />}
                      title="Report an error"
                      onClick={() =>
                        setCorrectionTarget({
                          recordType: "payment",
                          recordId: row.id,
                          currentValues: { amount: row.amount, mode: row.mode, paid_at: row.paid_at },
                        })
                      }
                    />
                  ),
                },
              ]}
            />
          </div>

          <div>
            <Typography.Title level={5}>Bucket Movements</Typography.Title>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={detail.bucket_movements}
              locale={{ emptyText: "No movement events detected" }}
              columns={[
                { title: "From", dataIndex: "from_bucket" },
                { title: "To", dataIndex: "to_bucket", render: orDash },
                {
                  title: "Trigger",
                  dataIndex: "trigger",
                  render: (v: string) => <Tag>{v === "payment" ? "Payment (in-month)" : "Allocation (confirmed)"}</Tag>,
                },
                {
                  title: "Month",
                  dataIndex: "month",
                  render: (v: string) => dayjs(v).format("MMM YYYY"),
                },
              ]}
            />
          </div>

          <div>
            <Typography.Title level={5}>Allocation History</Typography.Title>
            {detail.allocation_history.length === 0 ? (
              <Empty description="No allocation history" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Timeline
                items={detail.allocation_history.map((a) => ({
                  children: (
                    <>
                      <Typography.Text strong>
                        {orDash(a.from_agent_name)} → {a.to_agent_name}
                      </Typography.Text>{" "}
                      <Typography.Text type="secondary">
                        {dayjs(a.created_at).format("DD MMM YYYY")} by {a.allocated_by_name}
                      </Typography.Text>
                      <div>{orDash(a.reason)}</div>
                    </>
                  ),
                }))}
              />
            )}
          </div>

          <div>
            <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                Documents
              </Typography.Title>
              <Upload {...uploadProps}>
                <Button icon={<UploadOutlined />} size="small">
                  Upload
                </Button>
              </Upload>
            </Space>
            <Table
              size="small"
              rowKey="id"
              loading={attachmentsLoading}
              pagination={false}
              dataSource={attachments}
              locale={{ emptyText: "No supporting documents uploaded" }}
              columns={[
                {
                  title: "File",
                  dataIndex: "file_name",
                  render: (v: string, row: Attachment) => (
                    <>
                      {row.kind === "document" ? <FilePdfOutlined /> : <FileImageOutlined />} {v}
                    </>
                  ),
                },
                { title: "Note", dataIndex: "note", render: orDash },
                { title: "Uploaded By", dataIndex: "uploaded_by_name" },
                {
                  title: "Date",
                  dataIndex: "created_at",
                  render: (v: string) => dayjs(v).format("DD MMM YYYY"),
                },
                {
                  title: "",
                  key: "actions",
                  render: (_: unknown, row: Attachment) => (
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      onClick={() => downloadAttachment(row)}
                    />
                  ),
                },
              ]}
            />
          </div>

          <div>
            <Typography.Title level={5}>Month Snapshots</Typography.Title>
            <Table
              size="small"
              rowKey="month"
              pagination={false}
              dataSource={detail.snapshots}
              locale={{ emptyText: "No monthly snapshots yet" }}
              columns={[
                { title: "Month", dataIndex: "month", render: (v: string) => dayjs(v).format("MMM YYYY") },
                { title: "Bucket", dataIndex: "bucket", render: orDash },
                { title: "Due Amount", dataIndex: "due_amount", render: fmtAmount },
                { title: "EMI", dataIndex: "emi", render: fmtAmount },
                { title: "Product", dataIndex: "product", render: orDash },
              ]}
            />
          </div>
        </Space>
      )}
      {correctionTarget && (
        <ReportCorrectionModal
          recordType={correctionTarget.recordType}
          recordId={correctionTarget.recordId}
          currentValues={correctionTarget.currentValues}
          open={correctionTarget !== null}
          onClose={() => setCorrectionTarget(null)}
          onSubmitted={loadDetail}
        />
      )}
      {editRemarkTrailId && (
        <EditRemarkModal
          kind="call"
          recordId={editRemarkTrailId}
          currentText={detail?.trail.find((t) => t.id === editRemarkTrailId)?.extra_remark ?? ""}
          open={editRemarkTrailId !== null}
          onClose={() => setEditRemarkTrailId(null)}
          onSaved={() => {
            setEditRemarkTrailId(null);
            loadDetail();
          }}
        />
      )}
      {ptpModalTarget !== undefined && detail && (
        <PtpFormModal
          customerId={detail.customer.id}
          customerName={detail.customer.customer_name}
          existing={ptpModalTarget}
          open={ptpModalTarget !== undefined}
          onClose={() => setPtpModalTarget(undefined)}
          onSaved={loadDetail}
        />
      )}
    </Drawer>
  );
}
