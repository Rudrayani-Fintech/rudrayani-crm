import { useEffect, useState } from "react";
import { Checkbox, DatePicker, InputNumber, Modal, Select, Space, Typography, Upload, message } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import type { UploadFile } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, errorMessage } from "../api/client";
import { palette } from "../theme/tokens";
import { rupees } from "../utils/money";

const MODE_OPTIONS = ["Cash", "NEFT", "RTGS", "UPI", "Cheque", "DD"].map((m) => ({ value: m, label: m }));
// Phase 12 (Management Dashboard "Settlement vs EMI Collections" KPI).
const TYPE_OPTIONS = [
  { value: "emi", label: "EMI Collection" },
  { value: "settlement", label: "Settlement" },
];

/**
 * Record a payment from the web worklist -- same field set and photo-proof
 * requirement as mobile's payment_screen.dart, submitted as multipart/form-data
 * to the same POST /payments endpoint (field name must stay exactly "photo"
 * to match the backend's upload.single("photo")). Includes the same
 * exceeds-due-amount warning (D2): never blocks, just requires a deliberate
 * acknowledgement before submit.
 */
export default function RecordPaymentModal({
  customerId,
  customerName,
  dueAmount,
  open,
  onClose,
  onSaved,
}: {
  customerId: string;
  customerName: string;
  dueAmount: number | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState<number | null>(null);
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [type, setType] = useState<string>("emi");
  const [paidAt, setPaidAt] = useState<Dayjs | null>(null);
  const [closeCustomer, setCloseCustomer] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [confirmedExceedsDue, setConfirmedExceedsDue] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount(null);
      setMode(undefined);
      setType("emi");
      setPaidAt(null);
      setCloseCustomer(false);
      setPhoto(null);
      setConfirmedExceedsDue(false);
    }
  }, [open]);

  const exceedsDue = dueAmount != null && amount != null && amount > dueAmount;
  // Drives the Save button below -- computed live so the form disables
  // itself instead of letting the agent click Save and find out afterward.
  const canSubmit = amount != null && amount > 0 && (!exceedsDue || confirmedExceedsDue);

  const submit = async () => {
    if (!canSubmit) return; // unreachable via the UI; guards direct calls
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("customer_id", customerId);
      form.append("amount", String(amount));
      form.append("type", type);
      if (mode) form.append("mode", mode);
      if (paidAt) form.append("paid_at", paidAt.format("YYYY-MM-DD"));
      form.append("close_customer", String(closeCustomer));
      if (photo) form.append("photo", photo);
      // Mobile's offline queue has always sent this (double-submit
      // protection on retry); the web client never did, so a double-click
      // or a retried request after a dropped response had no protection
      // at all here. crypto.randomUUID() needs no new dependency.
      form.append("client_key", crypto.randomUUID());

      const res = await api.post("/payments", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      message.success(res.data.customer_closed ? "Payment recorded — loan closed" : "Payment recorded");
      onSaved();
      onClose();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`Record Payment — ${customerName}`}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="Save"
      okButtonProps={{ disabled: !canSubmit }}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <div>
          <Typography.Text>
            Amount Collected (₹) <Typography.Text type="danger">*</Typography.Text>
          </Typography.Text>
          <InputNumber
            style={{ width: "100%", marginTop: 4 }}
            min={0}
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setConfirmedExceedsDue(false);
            }}
          />
          {exceedsDue && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                background: palette.warningContainer,
                borderRadius: 6,
              }}
            >
              <Typography.Text style={{ fontSize: 12, color: palette.warning }}>
                This is more than what&apos;s owed ({rupees(dueAmount)} due). Double-check
                the amount.
              </Typography.Text>
              <div>
                <Checkbox
                  checked={confirmedExceedsDue}
                  onChange={(e) => setConfirmedExceedsDue(e.target.checked)}
                >
                  Yes, this amount is correct
                </Checkbox>
              </div>
            </div>
          )}
        </div>
        <div>
          <Typography.Text>Payment Mode</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            allowClear
            value={mode}
            onChange={setMode}
            options={MODE_OPTIONS}
          />
        </div>
        <div>
          <Typography.Text>Collection Type</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            value={type}
            onChange={setType}
            options={TYPE_OPTIONS}
          />
        </div>
        <div>
          <Typography.Text>Payment Date</Typography.Text>
          <DatePicker
            style={{ width: "100%", marginTop: 4 }}
            value={paidAt}
            onChange={setPaidAt}
            placeholder="Today if blank"
            disabledDate={(d) => d.isAfter(dayjs())}
          />
        </div>
        <div>
          <Typography.Text>Photo Proof</Typography.Text>
          <div style={{ marginTop: 4 }}>
            <Upload
              accept="image/jpeg,image/png,image/webp"
              maxCount={1}
              fileList={
                photo
                  ? ([{ uid: "1", name: photo.name, status: "done" }] as UploadFile[])
                  : []
              }
              beforeUpload={(file) => {
                if (file.size > 8 * 1024 * 1024) {
                  message.error("Photo must be under 8 MB");
                  return Upload.LIST_IGNORE;
                }
                setPhoto(file);
                return false;
              }}
              onRemove={() => setPhoto(null)}
            >
              <span>
                <UploadOutlined /> Upload photo
              </span>
            </Upload>
          </div>
        </div>
        <Checkbox
          checked={closeCustomer}
          onChange={(e) => {
            if (!e.target.checked) return setCloseCustomer(false);
            // Mirrors the same confirm added to mobile's payment_screen.dart
            // -- an irreversible toggle deserves a deliberate second tap,
            // not a single misplaced click.
            Modal.confirm({
              title: "Mark customer as Closed?",
              content: "This clears the assignment and sets the loan status to closed. This cannot be undone from here.",
              okText: "Close customer",
              onOk: () => setCloseCustomer(true),
            });
          }}
        >
          Mark customer as Closed
          <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
            Clears assignment and sets status to closed
          </Typography.Text>
        </Checkbox>
      </Space>
    </Modal>
  );
}
