import { useEffect, useState } from "react";
import { DatePicker, Input, InputNumber, Modal, Radio, Select, Space, Typography, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { api, errorMessage } from "../api/client";
import { rupees } from "../utils/money";
import type { DispositionCode } from "../types";

const MODE_OPTIONS = ["NEFT", "RTGS", "Cash", "UPI", "Cheque", "DD"].map((m) => ({ value: m, label: m }));

/**
 * Log a call from the web worklist -- same 4-step contract as mobile's
 * call_log_screen.dart: Channel (FV/OC) -> Result Code (filtered to that
 * channel) -> dynamic fields (purely from the selected disposition code's
 * needs_* flags) -> Remarks. Switching channel resets the code and every
 * downstream field, same as mobile. The server enforces the same needs_*
 * set via missingRequiredFields, so client-side validation here is a
 * fast-fail convenience, not the source of truth. No client_key -- that
 * exists for mobile's offline-retry queue, which web doesn't have.
 */
export default function LogCallModal({
  customerId,
  customerName,
  dispositionCodes,
  open,
  onClose,
  onSaved,
}: {
  customerId: string;
  customerName: string;
  dispositionCodes: DispositionCode[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [channel, setChannel] = useState<"FV" | "OC" | undefined>(undefined);
  const [codeId, setCodeId] = useState<string | undefined>(undefined);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [time, setTime] = useState("");
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [nameRelation, setNameRelation] = useState("");
  const [extraRemark, setExtraRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const codesForChannel = dispositionCodes.filter((c) => c.channel === channel);
  const code = dispositionCodes.find((c) => c.id === codeId);

  // Computed on every render (cheap, no async) so the Save button can be
  // disabled until the form is actually valid -- previously this exact
  // list of conditions only ran inside submit(), so an agent could click
  // Save on an incomplete form and get told what's wrong only afterward.
  const missing: string[] = [];
  if (!channel) missing.push("channel");
  else if (!code) missing.push("result code");
  else {
    if (code.needs_amount && amount == null) missing.push("amount");
    if (code.needs_date && !date) missing.push("date");
    if (code.needs_time && !time.trim()) missing.push("time");
    if (code.needs_mode && !mode) missing.push("mode");
    if (code.needs_reason && !reason.trim()) missing.push("reason");
    if (code.needs_name_relation && !nameRelation.trim()) missing.push("name/relation");
  }

  const resetFields = () => {
    setAmount(null);
    setDate(null);
    setTime("");
    setMode(undefined);
    setReason("");
    setNameRelation("");
  };

  const selectChannel = (value: "FV" | "OC") => {
    setChannel(value);
    setCodeId(undefined); // step 2 resets when channel changes (brief §5/§6)
    resetFields();
  };

  useEffect(() => {
    if (open) {
      setChannel(undefined);
      setCodeId(undefined);
      resetFields();
      setExtraRemark("");
    }
  }, [open]);

  const submit = async () => {
    // Unreachable via the UI (the Save button is disabled while `missing`
    // is non-empty) -- kept as a guard against calling submit() directly.
    if (!channel || !code || missing.length > 0) return;

    const fields: Record<string, string | number> = {};
    if (code.needs_amount && amount != null) fields.amount = amount;
    if (code.needs_date && date) fields.date = date.format("YYYY-MM-DD");
    if (code.needs_time && time.trim()) fields.time = time.trim();
    if (code.needs_mode && mode) fields.mode = mode;
    if (code.needs_reason && reason.trim()) fields.reason = reason.trim();
    if (code.needs_name_relation && nameRelation.trim()) fields.name_relation = nameRelation.trim();

    setSubmitting(true);
    try {
      const res = await api.post("/call-logs", {
        customer_id: customerId,
        disposition_code_id: code.id,
        fields,
        extra_remark: extraRemark.trim() || undefined,
      });
      if (res.data.ptp) {
        message.success(
          `Call logged — PTP recorded: ${rupees(res.data.ptp.amount)} by ${dayjs(res.data.ptp.promised_date).format("DD MMM")}`,
        );
      } else {
        message.success("Call logged");
      }
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
      title={`Log Call — ${customerName}`}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="Save"
      okButtonProps={{ disabled: missing.length > 0 }}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        {/* Step 1: Channel */}
        <div>
          <Typography.Text>
            Channel <Typography.Text type="danger">*</Typography.Text>
          </Typography.Text>
          <div style={{ marginTop: 4 }}>
            <Radio.Group
              value={channel}
              onChange={(e) => selectChannel(e.target.value)}
              options={[
                { value: "FV", label: "Field Visit" },
                { value: "OC", label: "On-Call" },
              ]}
              optionType="button"
            />
          </div>
        </div>

        {/* Step 2: Result Code, filtered to the chosen channel */}
        {channel && (
          <div>
            <Typography.Text>
              Result Code <Typography.Text type="danger">*</Typography.Text>
            </Typography.Text>
            <Select
              style={{ width: "100%", marginTop: 4 }}
              title="Choose a result code" placeholder="Choose a result code"
              showSearch
              optionFilterProp="label"
              value={codeId}
              onChange={setCodeId}
              notFoundContent={`No ${channel} codes configured`}
              options={codesForChannel.map((c) => ({
                value: c.id,
                label: `${c.action_code}_${c.result_code ?? ""} — ${c.description}`,
              }))}
            />
          </div>
        )}

        {/* Step 3: dynamic fields, driven by the selected code's needs_* flags */}
        {code?.needs_amount && (
          <div>
            <Typography.Text>
              Amount (₹) <Typography.Text type="danger">*</Typography.Text>
            </Typography.Text>
            <InputNumber style={{ width: "100%", marginTop: 4 }} value={amount} onChange={setAmount} min={0} />
          </div>
        )}
        {code?.needs_date && (
          <div>
            <Typography.Text>
              Date <Typography.Text type="danger">*</Typography.Text>
            </Typography.Text>
            <DatePicker style={{ width: "100%", marginTop: 4 }} value={date} onChange={setDate} />
          </div>
        )}
        {code?.needs_time && (
          <div>
            <Typography.Text>
              Time <Typography.Text type="danger">*</Typography.Text>
            </Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              placeholder="HH:MM"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        )}
        {code?.needs_mode && (
          <div>
            <Typography.Text>
              Mode <Typography.Text type="danger">*</Typography.Text>
            </Typography.Text>
            <Select style={{ width: "100%", marginTop: 4 }} value={mode} onChange={setMode} options={MODE_OPTIONS} />
          </div>
        )}
        {code?.needs_reason && (
          <div>
            <Typography.Text>
              Reason <Typography.Text type="danger">*</Typography.Text>
            </Typography.Text>
            <Input.TextArea
              style={{ marginTop: 4 }}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        {code?.needs_name_relation && (
          <div>
            <Typography.Text>
              Name / Relation <Typography.Text type="danger">*</Typography.Text>
            </Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              value={nameRelation}
              onChange={(e) => setNameRelation(e.target.value)}
            />
          </div>
        )}
        {code && code.needs_amount && code.needs_date && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            This will record a Promise to Pay if it matches a promise-type disposition.
          </Typography.Text>
        )}

        {/* Step 4: Remarks — last step before submit */}
        {code && (
          <div>
            <Typography.Text>Remarks (optional)</Typography.Text>
            <Input.TextArea
              style={{ marginTop: 4 }}
              rows={2}
              value={extraRemark}
              onChange={(e) => setExtraRemark(e.target.value)}
            />
          </div>
        )}

        {code && missing.length > 0 && (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            Still needed: {missing.join(", ")}
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}
