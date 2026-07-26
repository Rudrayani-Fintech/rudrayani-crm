import { useEffect, useState } from "react";
import { Button, DatePicker, InputNumber, Modal, Select, Space, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, errorMessage } from "../api/client";

const MODE_OPTIONS = ["Cash", "NEFT", "RTGS", "UPI", "Cheque", "DD"].map((m) => ({ value: m, label: m }));

export interface PtpRecord {
  id: string;
  amount: string;
  promised_date: string;
  status: string;
  mode: string | null;
}

/**
 * Create/reschedule a PTP and mark it kept/broken -- previously a PTP could
 * only be created as a side effect of logging a call with a PTP-flavored
 * disposition. There was no first-class create/edit action anywhere in the
 * product (mobile or web), and this drawer's PTP table was read-only aside
 * from "report an error" (a correction request, not a direct edit).
 */
export default function PtpFormModal({
  customerId,
  customerName,
  existing,
  open,
  onClose,
  onSaved,
}: {
  customerId: string;
  customerName: string;
  existing?: PtpRecord | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [amount, setAmount] = useState<number | null>(null);
  const [promisedDate, setPromisedDate] = useState<Dayjs | null>(null);
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(existing ? Number(existing.amount) : null);
    setPromisedDate(existing ? dayjs(existing.promised_date) : dayjs());
    setMode(existing?.mode ?? undefined);
  }, [open, existing]);

  const submit = async () => {
    if (amount == null || amount <= 0) {
      message.error("Enter a valid promised amount");
      return;
    }
    if (!promisedDate) {
      message.error("Pick a promised date");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        amount,
        promised_date: promisedDate.format("YYYY-MM-DD"),
        mode: mode ?? undefined,
      };
      if (isEdit) {
        await api.patch(`/ptps/${existing!.id}`, body);
        message.success("PTP updated");
      } else {
        await api.post("/ptps", { ...body, customer_id: customerId });
        message.success("PTP created");
      }
      onSaved();
      onClose();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const resolve = async (status: "kept" | "broken") => {
    if (!existing) return;
    setSubmitting(true);
    try {
      await api.patch(`/ptps/${existing.id}`, { status });
      message.success(status === "kept" ? "Marked as kept" : "Marked as broken");
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
      title={isEdit ? `Reschedule PTP — ${customerName}` : `New Promise to Pay — ${customerName}`}
      open={open}
      onCancel={onClose}
      confirmLoading={submitting}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        ...(isEdit
          ? [
              <Button key="broken" danger disabled={submitting} onClick={() => resolve("broken")}>
                Mark Broken
              </Button>,
              <Button
                key="kept"
                disabled={submitting}
                style={{ color: "#059669", borderColor: "#059669" }}
                onClick={() => resolve("kept")}
              >
                Mark Kept
              </Button>,
            ]
          : []),
        <Button key="save" type="primary" loading={submitting} onClick={submit}>
          {isEdit ? "Save Changes" : "Create PTP"}
        </Button>,
      ]}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <div>
          <Typography.Text>
            Promised Amount (₹) <Typography.Text type="danger">*</Typography.Text>
          </Typography.Text>
          <InputNumber style={{ width: "100%", marginTop: 4 }} min={0} value={amount} onChange={setAmount} />
        </div>
        <div>
          <Typography.Text>
            Promised Date <Typography.Text type="danger">*</Typography.Text>
          </Typography.Text>
          <DatePicker style={{ width: "100%", marginTop: 4 }} value={promisedDate} onChange={setPromisedDate} />
        </div>
        <div>
          <Typography.Text>Mode (optional)</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            allowClear
            value={mode}
            onChange={setMode}
            options={MODE_OPTIONS}
          />
        </div>
      </Space>
    </Modal>
  );
}
