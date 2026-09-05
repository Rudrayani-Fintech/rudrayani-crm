import { useEffect, useState } from "react";
import { DatePicker, Input, InputNumber, Modal, Select, Space, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, errorMessage } from "../api/client";

export type CorrectableRecordType = "payment" | "call_log" | "ptp" | "field_visit" | "customer";

interface FieldDef {
  key: string;
  label: string;
  kind: "amount" | "date" | "mode" | "text";
}

const FIELDS_BY_TYPE: Record<CorrectableRecordType, FieldDef[]> = {
  payment: [
    { key: "amount", label: "Amount", kind: "amount" },
    { key: "mode", label: "Mode", kind: "mode" },
    { key: "paid_at", label: "Paid At", kind: "date" },
  ],
  call_log: [{ key: "remark", label: "Remark", kind: "text" }],
  ptp: [
    { key: "amount", label: "Amount", kind: "amount" },
    { key: "promised_date", label: "Promised Date", kind: "date" },
  ],
  field_visit: [{ key: "remark", label: "Remark", kind: "text" }],
  // N3: address is the only correctable field for a customer record --
  // matches the backend's own ALLOWED_FIELDS.customer allow-list.
  customer: [{ key: "address", label: "Address", kind: "text" }],
};

const MODE_OPTIONS = ["NEFT", "RTGS", "Cash", "UPI", "Cheque", "DD"].map((m) => ({ value: m, label: m }));

/**
 * "Report an error" — lets an agent flag a mistake on their own payment /
 * call-log / PTP / field-visit for a TL/ops to review and apply
 * (POST /correction-requests). Pre-filled with the record's current values;
 * only fields the agent actually changes are sent as proposed_changes.
 */
export default function ReportCorrectionModal({
  recordType,
  recordId,
  currentValues,
  open,
  onClose,
  onSubmitted,
}: {
  recordType: CorrectableRecordType;
  recordId: string;
  currentValues: Record<string, string | number | null>;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const fields = FIELDS_BY_TYPE[recordType];
  const [values, setValues] = useState<Record<string, string | number | null>>({});
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({ ...currentValues });
      setReason("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recordId]);

  const submit = async () => {
    if (reason.trim().length < 3) {
      message.error("Please explain what's wrong (at least a few words)");
      return;
    }
    const proposedChanges: Record<string, string | number> = {};
    for (const f of fields) {
      const newVal = values[f.key];
      const oldVal = currentValues[f.key];
      if (newVal != null && String(newVal) !== String(oldVal ?? "")) {
        proposedChanges[f.key] = newVal;
      }
    }
    if (Object.keys(proposedChanges).length === 0) {
      message.error("Change at least one field, or there's nothing to correct");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/correction-requests", {
        record_type: recordType,
        record_id: recordId,
        proposed_changes: proposedChanges,
        reason: reason.trim(),
      });
      message.success("Correction request sent for review");
      onSubmitted();
      onClose();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Report an error"
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="Send for review"
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Typography.Text type="secondary">
          A team lead or ops will review this before anything changes. Only edit the field(s) that are wrong.
        </Typography.Text>
        {fields.map((f) => (
          <div key={f.key}>
            <Typography.Text>{f.label}</Typography.Text>
            {f.kind === "amount" && (
              <InputNumber
                style={{ width: "100%", marginTop: 4 }}
                prefix="₹"
                value={values[f.key] as number | null}
                onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              />
            )}
            {f.kind === "mode" && (
              <Select
                style={{ width: "100%", marginTop: 4 }}
                allowClear
                options={MODE_OPTIONS}
                value={values[f.key] as string | null}
                onChange={(v) => setValues((s) => ({ ...s, [f.key]: v ?? null }))}
              />
            )}
            {f.kind === "date" && (
              <DatePicker
                style={{ width: "100%", marginTop: 4 }}
                value={values[f.key] ? dayjs(values[f.key] as string) : null}
                onChange={(d: Dayjs | null) =>
                  setValues((s) => ({ ...s, [f.key]: d ? d.format("YYYY-MM-DD") : null }))
                }
              />
            )}
            {f.kind === "text" && (
              <Input.TextArea
                style={{ marginTop: 4 }}
                rows={2}
                value={(values[f.key] as string) ?? ""}
                onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            )}
          </div>
        ))}
        <div>
          <Typography.Text>
            What's wrong? <Typography.Text type="danger">*</Typography.Text>
          </Typography.Text>
          <Input.TextArea
            style={{ marginTop: 4 }}
            rows={2}
            placeholder="e.g. Typo'd the amount, customer actually paid ₹5,500"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Space>
    </Modal>
  );
}
