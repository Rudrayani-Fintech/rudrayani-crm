import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { DispositionCode } from "../types";

type FormValues = {
  action_code: string;
  category?: string;
  result_code?: string;
  description: string;
  remark_template?: string;
  channel: "FV" | "OC";
  needs_amount: boolean;
  needs_date: boolean;
  needs_time: boolean;
  needs_mode: boolean;
  needs_reason: boolean;
  needs_name_relation: boolean;
};

const NEEDS_FLAGS: { key: keyof FormValues; label: string }[] = [
  { key: "needs_amount", label: "Amount" },
  { key: "needs_date", label: "Date" },
  { key: "needs_time", label: "Time" },
  { key: "needs_mode", label: "Mode" },
  { key: "needs_reason", label: "Reason" },
  { key: "needs_name_relation", label: "Name/Relation" },
];

export default function DispositionsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("dispositions.manage");

  const [codes, setCodes] = useState<DispositionCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<DispositionCode | "new" | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get("/dispositions", {
        params: showInactive ? { include_inactive: "true" } : {},
      });
      setCodes(res.data.disposition_codes);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({
      needs_amount: false,
      needs_date: false,
      needs_time: false,
      needs_mode: false,
      needs_reason: false,
      needs_name_relation: false,
    });
    setEditing("new");
  };

  const openEdit = (code: DispositionCode) => {
    form.setFieldsValue({
      action_code: code.action_code,
      category: code.category ?? undefined,
      result_code: code.result_code ?? undefined,
      description: code.description,
      remark_template: code.remark_template ?? undefined,
      channel: code.channel ?? undefined,
      needs_amount: code.needs_amount,
      needs_date: code.needs_date,
      needs_time: code.needs_time,
      needs_mode: code.needs_mode,
      needs_reason: code.needs_reason,
      needs_name_relation: code.needs_name_relation,
    });
    setEditing(code);
  };

  const save = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      if (editing === "new") {
        await api.post("/dispositions", values);
        message.success("Disposition code added");
      } else if (editing) {
        await api.patch(`/dispositions/${editing.id}`, values);
        message.success("Disposition code updated");
      }
      setEditing(null);
      load();
    } catch (err) {
      if ((err as { errorFields?: unknown }).errorFields) return; // validation error — form shows inline
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const applyToggle = async (code: DispositionCode) => {
    try {
      await api.patch(`/dispositions/${code.id}`, { is_active: !code.is_active });
      message.success(code.is_active ? "Code retired" : "Code re-activated");
      load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const toggleActive = (code: DispositionCode) => {
    // Re-activating is harmless; retiring hides the code from every agent's
    // call-log dropdown immediately -- worth a confirmation, not silent.
    if (!code.is_active) return applyToggle(code);
    Modal.confirm({
      title: `Retire "${code.description}"?`,
      content: "Agents will no longer be able to select this code when logging a call.",
      okText: "Retire",
      okButtonProps: { danger: true },
      onOk: () => applyToggle(code),
    });
  };

  const needsFlags = (code: DispositionCode) =>
    NEEDS_FLAGS.filter((f) => code[f.key as keyof DispositionCode]).map((f) => (
      <Tag key={f.key} color="blue" style={{ fontSize: 11 }}>
        {f.label}
      </Tag>
    ));

  const uncategorizedCount = codes.filter((c) => c.channel == null).length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Disposition Codes
        </Typography.Title>
        <Space>
          <Space>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              Show retired
            </Typography.Text>
            <Switch size="small" checked={showInactive} onChange={setShowInactive} />
          </Space>
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Add code
            </Button>
          )}
        </Space>
      </div>

      {uncategorizedCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${uncategorizedCount} code${uncategorizedCount === 1 ? "" : "s"} without a channel`}
          description="These are custom codes that don't match a known FV/OC/LG prefix from the master list. Edit each to assign Field Visit or On-Call so it appears in the agent picker."
        />
      )}

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          action={<Button size="small" onClick={() => load()}>Retry</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={codes}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        columns={[
          { title: "Action", dataIndex: "action_code", width: 80 },
          {
            title: "Channel",
            dataIndex: "channel",
            width: 90,
            render: (v: "FV" | "OC" | null) =>
              v ? (
                <Tag color={v === "FV" ? "geekblue" : "purple"}>{v}</Tag>
              ) : (
                <Tag color="default">Unset</Tag>
              ),
          },
          { title: "Category", dataIndex: "category", width: 180, render: (v) => v ?? "—" },
          { title: "Result", dataIndex: "result_code", width: 80, render: (v) => v ?? "—" },
          { title: "Description", dataIndex: "description" },
          {
            title: "Requires",
            key: "needs",
            render: (_, record) => <Space size={2}>{needsFlags(record)}</Space>,
          },
          {
            title: "Status",
            dataIndex: "is_active",
            width: 90,
            render: (active: boolean) => (
              <Tag color={active ? "success" : "default"}>{active ? "Active" : "Retired"}</Tag>
            ),
          },
          canManage
            ? {
                title: "",
                key: "actions",
                width: 140,
                render: (_, record) => (
                  <Space>
                    <Button type="link" size="small" onClick={() => openEdit(record)}>
                      Edit
                    </Button>
                    <Tooltip title={record.is_active ? "Retire this code" : "Re-activate"}>
                      <Button
                        type="link"
                        size="small"
                        danger={record.is_active}
                        onClick={() => toggleActive(record)}
                      >
                        {record.is_active ? "Retire" : "Restore"}
                      </Button>
                    </Tooltip>
                  </Space>
                ),
              }
            : { width: 0, render: () => null },
        ]}
      />

      <Modal
        open={editing !== null}
        title={editing === "new" ? "Add disposition code" : "Edit disposition code"}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        width={580}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              name="action_code"
              label="Action Code"
              rules={[{ required: true, message: "Required" }]}
              style={{ flex: 1 }}
            >
              <Input placeholder="OC, FV, LG..." />
            </Form.Item>
            <Form.Item name="result_code" label="Result Code" style={{ flex: 1 }}>
              <Input placeholder="PTP, BP, RTP..." />
            </Form.Item>
          </Space.Compact>

          <Form.Item
            name="channel"
            label="Channel"
            rules={[{ required: true, message: "Required" }]}
            tooltip="Which flow this code appears in: Field Visit (FV) or On-Call (OC)"
          >
            <Select
              title="Select channel" placeholder="Select channel"
              options={[
                { value: "FV", label: "Field Visit (FV)" },
                { value: "OC", label: "On-Call (OC)" },
              ]}
            />
          </Form.Item>

          <Form.Item name="category" label="Category">
            <Input placeholder="PROMISE TO PAY, DISPUTE..." />
          </Form.Item>

          <Form.Item
            name="description"
            label="Description"
            rules={[{ required: true, message: "Required" }]}
          >
            <Input placeholder="e.g. Promised to Pay" />
          </Form.Item>

          <Form.Item name="remark_template" label="Remark template">
            <Input.TextArea
              rows={2}
              placeholder="Customer promised to pay ₹{amount} by {date} via {mode}"
            />
          </Form.Item>

          <Form.Item label="Required fields when this code is selected">
            <Space wrap>
              {NEEDS_FLAGS.map((f) => (
                <Form.Item key={f.key} name={f.key} valuePropName="checked" noStyle>
                  <Checkbox>{f.label}</Checkbox>
                </Form.Item>
              ))}
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
