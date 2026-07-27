import {
  Alert,
  Button,
  Card,
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
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Company } from "../types";

/**
 * Owner feedback round, Phase 10: admin surface for the system field master
 * catalog (system_field_definitions, agency-wide) and per-company
 * configuration (company_field_settings) that replaced the old compile-time
 * SYSTEM_FIELDS const import-service.ts used to read. Only loan_number and
 * customer_name (STRUCTURALLY_REQUIRED_FIELDS -- the dedup key, and directly
 * depended on by the import pipeline) can never be disabled or deleted;
 * every other core field is deletable like a custom one, an admin's own
 * decision about what their data actually needs.
 */

interface FieldDefinition {
  id: string;
  field_key: string;
  label: string;
  storage_column: string | null;
  field_type: string;
  is_core: boolean;
  sort_order: number;
}

interface CatalogEntry {
  field_key: string;
  label: string;
  storage_column: string | null;
  field_type: string;
  is_core: boolean;
  is_enabled: boolean;
  is_required: boolean;
  sort_order: number;
}

// Structural pipeline dependencies -- mirrors STRUCTURALLY_REQUIRED_FIELDS in
// backend/src/services/field-config-service.ts. Kept in sync there; the
// server is the actual enforcement point, this only pre-empts a round trip.
const STRUCTURALLY_REQUIRED_FIELDS = ["loan_number", "customer_name"];

export default function FieldConfigPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<FieldDefinition[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  const [addForm] = Form.useForm();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.get("/companies").then((r) => setCompanies(r.data.companies)).catch((err) => message.error(errorMessage(err)));
  }, []);

  const loadDefinitions = useCallback(async () => {
    setDefinitionsError(null);
    try {
      const res = await api.get("/field-config/definitions");
      setDefinitions(res.data.definitions);
    } catch (err) {
      setDefinitionsError(errorMessage(err));
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    if (!companyId) { setCatalog([]); return; }
    setLoading(true);
    try {
      const res = await api.get("/field-config/settings", { params: { company_id: companyId } });
      setCatalog(res.data.fields);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void loadDefinitions(); }, [loadDefinitions]);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const addCustomField = async (values: { field_key: string; label: string; field_type: string }) => {
    setAdding(true);
    try {
      await api.post("/field-config/definitions", values);
      message.success(`Added "${values.label}" to the master catalog`);
      addForm.resetFields();
      await loadDefinitions();
      await loadCatalog();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const applyDelete = async (def: FieldDefinition) => {
    try {
      await api.delete(`/field-config/definitions/${def.id}`);
      message.success(`Removed "${def.label}" from the master catalog`);
      await loadDefinitions();
      await loadCatalog();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const deleteDefinition = (def: FieldDefinition) => {
    Modal.confirm({
      title: `Remove "${def.label}" from the master catalog?`,
      content:
        "This removes it from every company's field configuration going forward. Values already imported for this field stay on existing customer records.",
      okText: "Remove",
      okButtonProps: { danger: true },
      onOk: () => applyDelete(def),
    });
  };

  const patchSetting = async (
    fieldKey: string,
    body: { is_enabled?: boolean; is_required?: boolean },
  ) => {
    if (!companyId) return;
    try {
      await api.patch("/field-config/settings", { company_id: companyId, field_key: fieldKey, ...body });
      await loadCatalog();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  // Without this, clicking up/down twice quickly fires two overlapping PUTs
  // against the same optimistic array -- whichever response lands last wins,
  // silently discarding the other click's reorder.
  const [reordering, setReordering] = useState(false);
  const move = async (index: number, delta: -1 | 1) => {
    const next = [...catalog];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setCatalog(next); // optimistic
    setReordering(true);
    try {
      await api.put("/field-config/settings/reorder", {
        company_id: companyId,
        ordered_field_keys: next.map((f) => f.field_key),
      });
    } catch (err) {
      message.error(errorMessage(err));
      void loadCatalog();
    } finally {
      setReordering(false);
    }
  };

  return (
    <div>
      <Typography.Title level={4}>Field Configuration</Typography.Title>
      <Typography.Paragraph type="secondary">
        The 10 core loan-ledger fields (Loan Number, Customer Name, Mobile Number, Product, Bucket,
        Due Amount, POS, EMI, EMI Due Date, Agent Phone) plus Address make up the master catalog every
        agency starts with. Add custom fields here, then enable/require/order them per company below --
        disabled fields disappear from the Import wizard's mapping step but any values already imported
        for them stay visible on the customer's detail view. Loan Number and Customer Name can never be
        disabled or deleted (the import pipeline depends on them directly) -- every other field, core or
        custom, can be removed from the catalog if you decide you don't need it; deleting only affects
        future imports, not data already on file.
      </Typography.Paragraph>

      <Card title="Master catalog (agency-wide)" style={{ marginBottom: 24 }}>
        {definitionsError && (
          <Alert
            type="error"
            showIcon
            message={definitionsError}
            action={<Button size="small" onClick={() => void loadDefinitions()}>Retry</Button>}
            style={{ marginBottom: 16 }}
          />
        )}
        <Table<FieldDefinition>
          rowKey="id"
          dataSource={definitions}
          pagination={false}
          size="small"
          style={{ marginBottom: 16 }}
          columns={[
            { title: "Field key", dataIndex: "field_key", render: (v) => <code>{v}</code> },
            { title: "Label", dataIndex: "label" },
            { title: "Type", dataIndex: "field_type", render: (v) => <Tag>{v}</Tag> },
            {
              title: "Source",
              dataIndex: "is_core",
              render: (v: boolean) => (v ? <Tag color="blue">Core</Tag> : <Tag color="purple">Custom</Tag>),
            },
            {
              title: "",
              key: "actions",
              width: 90,
              render: (_, def) =>
                STRUCTURALLY_REQUIRED_FIELDS.includes(def.field_key) ? (
                  <Tooltip title="The import pipeline depends on this field directly — it can't be deleted">
                    <Button size="small" danger icon={<DeleteOutlined />} disabled />
                  </Tooltip>
                ) : (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => void deleteDefinition(def)}
                  />
                ),
            },
          ]}
        />

        <Form form={addForm} layout="inline" onFinish={(v) => void addCustomField(v)}>
          <Form.Item
            name="field_key"
            rules={[
              { required: true, message: "Required" },
              { pattern: /^[a-z][a-z0-9_]{1,49}$/, message: "lowercase, digits, underscores" },
            ]}
          >
            <Input placeholder="field_key (e.g. vehicle_number)" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="label" rules={[{ required: true, message: "Required" }]}>
            <Input placeholder="Label (e.g. Vehicle Number)" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="field_type" initialValue="text" rules={[{ required: true }]}>
            <Select
              style={{ width: 140 }}
              options={[
                { value: "text", label: "Text" },
                { value: "numeric", label: "Numeric" },
                { value: "date", label: "Date" },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={adding}>
              Add custom field
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="Per-company configuration">
        <Select
          style={{ width: 320, marginBottom: 16 }}
          title="Select a company" placeholder="Select a company"
          value={companyId}
          onChange={setCompanyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />

        {!companyId ? (
          <Alert type="info" showIcon message="Select a company to view/edit its field configuration." />
        ) : (
          <Table<CatalogEntry>
            rowKey="field_key"
            loading={loading}
            dataSource={catalog}
            pagination={false}
            size="small"
            columns={[
              {
                title: "Order",
                width: 90,
                render: (_, __, index) => (
                  <Space>
                    <Button
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={index === 0 || reordering}
                      onClick={() => void move(index, -1)}
                    />
                    <Button
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={index === catalog.length - 1 || reordering}
                      onClick={() => void move(index, 1)}
                    />
                  </Space>
                ),
              },
              {
                title: "Field",
                dataIndex: "label",
                render: (v, f) => (
                  <Space size={4}>
                    {v}
                    {f.is_core && <Tag color="blue">Core</Tag>}
                    {!f.storage_column && f.field_type !== "resolver" && <Tag>Custom field</Tag>}
                  </Space>
                ),
              },
              { title: "Type", dataIndex: "field_type", width: 100, render: (v) => <Tag>{v}</Tag> },
              {
                title: "Enabled",
                dataIndex: "is_enabled",
                width: 110,
                render: (v: boolean, f) => (
                  <Tooltip
                    title={
                      STRUCTURALLY_REQUIRED_FIELDS.includes(f.field_key)
                        ? "The import pipeline depends on this field directly — it can't be disabled"
                        : undefined
                    }
                  >
                    <Switch
                      checked={v}
                      disabled={STRUCTURALLY_REQUIRED_FIELDS.includes(f.field_key)}
                      onChange={(checked) =>
                        void patchSetting(f.field_key, {
                          is_enabled: checked,
                          is_required: checked ? f.is_required : false,
                        })
                      }
                    />
                  </Tooltip>
                ),
              },
              {
                title: "Required to map",
                dataIndex: "is_required",
                width: 130,
                render: (v: boolean, f) => (
                  <Switch
                    checked={v}
                    disabled={!f.is_enabled}
                    onChange={(checked) => void patchSetting(f.field_key, { is_required: checked })}
                  />
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
