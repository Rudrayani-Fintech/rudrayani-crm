import { useEffect, useState } from "react";
import { Input, Modal, Typography, message } from "antd";
import dayjs from "dayjs";
import { api, errorMessage } from "../api/client";

export type DirectEditableKind = "call" | "field_visit";

const ENDPOINT: Record<DirectEditableKind, (id: string) => string> = {
  call: (id) => `/call-logs/${id}/remark`,
  field_visit: (id) => `/field-visits/${id}/remark`,
};
const BODY_KEY: Record<DirectEditableKind, "extra_remark" | "remark"> = {
  call: "extra_remark",
  field_visit: "remark",
};

/**
 * Ownership + rolling-24h-window predicate backing the "Edit remark" vs
 * "Report an error" choice -- must match the server's own PATCH .../remark
 * window (call-logs.ts/field-visits.ts, `ageMs >= 24h`) or an agent could
 * see an "Edit" affordance the API then rejects with 409. Shared here
 * (rather than each caller re-deriving it) so MyWorklistPage.tsx and
 * CustomerDetailDrawer.tsx can't drift out of sync with each other or with
 * the server.
 */
export function canDirectEditRecord(
  createdAt: string,
  recordAgentId: string | null | undefined,
  userId: string | undefined,
): boolean {
  if (!userId || recordAgentId !== userId) return false;
  return dayjs().diff(dayjs(createdAt), "hour", true) < 24;
}

/**
 * Same-day (rolling 24h) owner-only remark edit -- distinct from
 * ReportCorrectionModal's "Report an error" (manager-approved, no time
 * limit). For a call log this edits only the free-text tail
 * (extra_remark); the disposition-driven portion of the composed remark is
 * recomputed server-side and never touched here.
 */
export default function EditRemarkModal({
  kind,
  recordId,
  currentText,
  open,
  onClose,
  onSaved,
}: {
  kind: DirectEditableKind;
  recordId: string;
  currentText: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(currentText);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setText(currentText);
  }, [open, currentText]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.patch(ENDPOINT[kind](recordId), { [BODY_KEY[kind]]: text.trim() });
      message.success("Remark updated");
      onSaved();
      onClose();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Edit remark" open={open} onCancel={onClose} onOk={submit} confirmLoading={submitting} okText="Save">
      <Typography.Text type="secondary">
        You can only edit this within 24 hours of logging it. After that, use "Report an error" instead.
      </Typography.Text>
      <Input.TextArea
        style={{ marginTop: 8 }}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={500}
      />
    </Modal>
  );
}
