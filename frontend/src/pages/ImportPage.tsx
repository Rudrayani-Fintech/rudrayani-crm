import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Steps,
  Table,
  Tag,
  Tabs,
  Typography,
  Upload,
  message,
} from "antd";
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  FileExcelOutlined,
  HistoryOutlined,
  InboxOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { RcFile } from "antd/es/upload";
import type { Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { palette } from "../theme/tokens";
import type { Company, ImportRun, ImportTemplate } from "../types";

// Owner feedback round, Phase 10: the system field list (which keys exist,
// which are required-to-map) is no longer a hardcoded const here -- it's
// fetched per company from the runtime catalog (system_field_definitions +
// company_field_settings, see backend field-config-service.ts) via the
// /imports/upload?company_id= response, so an agency admin's FieldConfigPage
// changes show up here without a frontend deploy.
interface FieldCatalogEntry {
  field_key: string;
  label: string;
  field_type: string;
  is_core: boolean;
  is_enabled: boolean;
  is_required: boolean;
  sort_order: number;
}

interface DiffSample {
  loan_number: string;
  customer_name: string | null;
  bucket: string | null;
  due_amount: number | null;
  pos?: number | null;
  agent_name?: string | null;
  previous_status?: string;
  product?: string | null;
  emi?: number | null;
  branch?: string | null;
}

interface PreviewResult {
  mode: "new" | "allocation";
  total_rows: number;
  error_rows: number;
  unmapped_columns: string[];
  errors: { row: number; problems: string[] }[];
  // mode = "new"
  valid_rows?: number;
  duplicates_in_db?: number;
  duplicate_loan_numbers?: string[];
  sample_rows?: DiffSample[];
  // mode = "allocation" (Phase 7 diff engine)
  is_repeat_import?: boolean;
  will_update?: number;
  additions?: { count: number; sample: DiffSample[] };
  removals?: { count: number; sample: DiffSample[] };
  reactivations?: { count: number; sample: DiffSample[] };
  new_buckets?: string[];
  new_products?: string[];
}

interface CommitResult {
  inserted_rows: number;
  updated_rows: number;
  duplicate_rows: number;
  error_rows: number;
  unknown_agent_phones: string[];
  pending_review: number;
  removal_flagged: number;
  new_buckets: string[];
  new_products: string[];
  is_repeat_import: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Import wizard (4-step flow)
// ──────────────────────────────────────────────────────────────────────────────

function ImportWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // A refresh at the mapping or preview step previously destroyed the
  // entire column mapping with no warning -- for a 20-column ledger that's
  // the ~40 dropdown clicks from 4.5 gone in one accidental Cmd+R. Nothing
  // to lose yet at step 0 (no file parsed), and step 3 is already committed.
  useEffect(() => {
    if (step !== 1 && step !== 2) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [step]);

  // Step 0
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [file, setFile] = useState<RcFile | null>(null);
  const [mode, setMode] = useState<"new" | "allocation">("allocation");
  const [allocationMonth, setAllocationMonth] = useState<Dayjs | null>(null);

  // Step 1
  const [uploadKey, setUploadKey] = useState("");
  const [fileName, setFileName] = useState("");
  const [detectedColumns, setDetectedColumns] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [templateName, setTemplateName] = useState("");
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null);
  // This company's runtime field catalog (Phase 10) -- returned by
  // /imports/upload?company_id=, drives the mapping dropdown + required list.
  const [systemFields, setSystemFields] = useState<FieldCatalogEntry[]>([]);
  const fieldOptions = systemFields.map((f) => ({
    value: f.field_key,
    label: f.is_required ? `${f.label} (required)` : f.label,
  }));
  const requiredMappedFields = systemFields.filter((f) => f.is_required).map((f) => f.field_key);
  const fieldLabel = (key: string) => systemFields.find((f) => f.field_key === key)?.label ?? key;

  // Step 2
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  // Step 3
  const [result, setResult] = useState<CommitResult | null>(null);

  useEffect(() => {
    api.get("/companies").then((r) => setCompanies(r.data.companies)).catch((err) => message.error(errorMessage(err)));
  }, []);

  // Load templates when company changes
  useEffect(() => {
    if (!companyId) { setTemplates([]); return; }
    api
      .get("/import-templates", { params: { company_id: companyId } })
      .then((r) =>
        setTemplates(
          (r.data.templates as ImportTemplate[]).filter((t) => t.is_active),
        ),
      )
      .catch((err) => message.error(errorMessage(err)));
  }, [companyId]);

  // ── Step 0: upload file ──────────────────────────────────────────────────

  const monthParam = () =>
    mode === "allocation" && allocationMonth
      ? { mode, allocation_month: allocationMonth.format("YYYY-MM-01") }
      : { mode };

  const canUpload = !!companyId && (mode !== "allocation" || !!allocationMonth) && !!file;

  const handleUpload = async () => {
    if (!canUpload) return; // unreachable via the UI; the button is disabled until this is true
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file as unknown as Blob);
      // Phase 10: company_id scopes the returned system_fields catalog to
      // this company's enabled/required config instead of the whole agency.
      const res = await api.post(`/imports/upload?company_id=${companyId}`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setUploadKey(res.data.upload_key);
      setFileName(file.name);
      setDetectedColumns(res.data.columns);
      setRowCount(res.data.row_count);
      setSystemFields(res.data.system_fields ?? []);
      // Clear mapping for the new file
      setMapping({});
      setSavedTemplateId(null);
      setTemplateName("");
      setStep(1);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // ── Step 1: map columns ──────────────────────────────────────────────────

  const applyTemplate = (templateId: string) => {
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;
    const newMapping: Record<string, string> = {};
    for (const col of detectedColumns) {
      const mapped = tpl.column_mapping[col];
      if (mapped) newMapping[col] = mapped;
    }
    setMapping(newMapping);
  };

  const handlePreview = async () => {
    // Validate: every required system field must be mapped to a column
    const mappedFields = Object.values(mapping);
    const missingRequired = requiredMappedFields.filter((f) => !mappedFields.includes(f));
    if (missingRequired.length > 0) {
      return message.error(
        `Map a column to every required field before previewing. Missing: ${missingRequired
          .map((f) => fieldLabel(f))
          .join(", ")}`,
      );
    }
    setLoading(true);
    try {
      let resolvedTemplateId = savedTemplateId;

      // Save as template if a name was provided
      if (templateName.trim()) {
        const saveRes = await api.post("/import-templates", {
          company_id: companyId,
          name: templateName.trim(),
          column_mapping: mapping,
        });
        resolvedTemplateId = saveRes.data.template.id;
        setSavedTemplateId(resolvedTemplateId);
        message.success(`Template "${templateName.trim()}" saved (v${saveRes.data.template.version})`);
      }

      const body: Record<string, unknown> = {
        upload_key: uploadKey,
        company_id: companyId,
        ...monthParam(),
      };
      if (resolvedTemplateId) {
        body.template_id = resolvedTemplateId;
      } else {
        body.column_mapping = mapping;
      }

      const res = await api.post("/imports/preview", body);
      setPreview(res.data);
      setStep(2);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: commit ───────────────────────────────────────────────────────

  const handleCommit = async () => {
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        upload_key: uploadKey,
        company_id: companyId,
        file_name: fileName,
        ...monthParam(),
      };
      if (savedTemplateId) {
        body.template_id = savedTemplateId;
      } else {
        body.column_mapping = mapping;
      }
      const res = await api.post("/imports/commit", body);
      setResult(res.data);
      setStep(3);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const restart = () => {
    setStep(0);
    setFile(null);
    setCompanyId(null);
    setUploadKey("");
    setDetectedColumns([]);
    setSystemFields([]);
    setMapping({});
    setTemplateName("");
    setSavedTemplateId(null);
    setPreview(null);
    setResult(null);
  };

  // ── Render steps ─────────────────────────────────────────────────────────

  const renderStep0 = () => (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <Form.Item label="Company" required>
        <Select
          style={{ width: 320 }}
          title="Select a company" placeholder="Select a company"
          value={companyId}
          onChange={setCompanyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Form.Item>

      <Form.Item label="Import type" required style={{ marginBottom: 0 }}>
        <Radio.Group
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          options={[
            { value: "new", label: "New customers" },
            { value: "allocation", label: "Monthly allocation" },
          ]}
          optionType="button"
        />
      </Form.Item>
      {mode === "allocation" && (
        <Form.Item
          label="Allocation month"
          required
          extra="Existing loans are updated with the file's bucket/amounts; every loan gets a snapshot for this month (feeds the performance dashboard)."
        >
          <DatePicker
            picker="month"
            value={allocationMonth}
            onChange={setAllocationMonth}
            style={{ width: 200 }}
          />
        </Form.Item>
      )}

      <Upload.Dragger
        accept=".xlsx"
        maxCount={1}
        beforeUpload={(f) => {
          // Previously this was just a hint below the dragger -- a 40 MB
          // file uploaded in full over 2G/3G and only failed minutes later,
          // server-side, after the wait.
          if (f.size > 15 * 1024 * 1024) {
            message.error("File is larger than 15 MB — split it or ask the sender for a smaller export.");
            return Upload.LIST_IGNORE;
          }
          setFile(f as RcFile);
          return false;
        }}
        onRemove={() => setFile(null)}
        fileList={file ? [file as unknown as import("antd").UploadFile] : []}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined style={{ color: palette.navy }} />
        </p>
        <p className="ant-upload-text">Click or drag an .xlsx file here</p>
        <p className="ant-upload-hint">Max 15 MB · Excel (.xlsx) only</p>
      </Upload.Dragger>

      <Button
        type="primary"
        size="large"
        icon={<CloudUploadOutlined />}
        onClick={handleUpload}
        loading={loading}
        disabled={!canUpload}
        style={{ height: 48, paddingInline: 32 }}
      >
        Upload & Detect Columns
      </Button>
    </Space>
  );

  const mappingTableData = detectedColumns.map((col) => ({
    col,
    mapped: mapping[col] ?? "",
  }));

  const renderStep1 = () => {
    const mappedValues = Object.values(mapping);
    const missingRequired = requiredMappedFields.filter((f) => !mappedValues.includes(f));
    // Owner feedback round, Phase 2 breaking-change mitigation (now Phase 10
    // runtime-catalog-aware): a template saved before a field became
    // required for this company won't map it -- surface that proactively
    // instead of letting the admin discover it as a failed commit on their
    // next monthly cycle.
    const templatesMissingRequired = templates
      .map((t) => ({
        name: t.name,
        missing: requiredMappedFields.filter((f) => !Object.values(t.column_mapping).includes(f)),
      }))
      .filter((t) => t.missing.length > 0);
    return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <Alert
        type="info"
        showIcon
        message={`${fileName} — ${rowCount} data rows, ${detectedColumns.length} columns detected`}
      />
      {missingRequired.length > 0 && (
        <Alert
          type="error"
          showIcon
          message="Required fields are not mapped"
          description={`Not mapped: ${missingRequired.map((f) => fieldLabel(f)).join(", ")}. Map a column to each before you can preview or commit.`}
        />
      )}
      {!systemFields.some((f) => f.field_key === "customer_branch") && (
        <Alert
          type="info"
          showIcon
          message="Customer Branch isn't mappable for this company yet"
          description="It's off by default per company. If this file has a branch column, enable Customer Branch in Field Config first, then re-upload to map it."
          action={
            <Button size="small" onClick={() => navigate("/field-config")}>
              Open Field Config
            </Button>
          }
        />
      )}
      {templatesMissingRequired.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Some saved templates are missing newly-required fields"
          description={templatesMissingRequired
            .map((t) => `"${t.name}" is missing ${t.missing.map((f) => fieldLabel(f)).join(", ")}`)
            .join("; ")}
        />
      )}

      {/* Load existing template */}
      {templates.length > 0 && (
        <div>
          <Typography.Text type="secondary">Load existing template:</Typography.Text>
          <Select
            style={{ marginLeft: 12, width: 260 }}
            title="Choose a saved template…" placeholder="Choose a saved template…"
            allowClear
            options={templates.map((t) => ({ value: t.id, label: `${t.name} (v${t.version})` }))}
            onChange={(id) => { if (id) applyTemplate(id); }}
          />
        </div>
      )}

      <Typography.Text type="secondary">
        Every column from the file — mapped or not — is kept and shown on the customer's detail view;
        nothing needs to be picked manually.
      </Typography.Text>

      {/* Mapping matrix */}
      <Table
        rowKey="col"
        dataSource={mappingTableData}
        pagination={false}
        size="small"
        columns={[
          {
            title: "Excel Column",
            dataIndex: "col",
            width: "40%",
            render: (v: string) => (
              <Typography.Text style={{ fontFamily: "monospace" }}>{v}</Typography.Text>
            ),
          },
          {
            title: "Maps to system field",
            dataIndex: "mapped",
            width: "40%",
            render: (_: string, record: { col: string }) => (
              <Select
                style={{ width: "100%" }}
                title="Skip this column" placeholder="Skip this column"
                allowClear
                value={mapping[record.col] || undefined}
                onChange={(v) =>
                  setMapping((prev) => {
                    const next = { ...prev };
                    if (v) next[record.col] = v;
                    else delete next[record.col];
                    return next;
                  })
                }
                options={fieldOptions}
              />
            ),
          },
        ]}
      />

      {/* Save as template */}
      <div>
        <Typography.Text type="secondary">
          Template name{" "}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            (optional — saves/versions this mapping for reuse)
          </Typography.Text>
        </Typography.Text>
        <Input
          style={{ marginTop: 4, width: 320 }}
          placeholder="e.g. Standard Ledger"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
        />
      </div>

      <Space>
        <Button onClick={() => setStep(0)}>Back</Button>
        <Button
          type="primary"
          size="large"
          onClick={handlePreview}
          loading={loading}
          style={{ height: 48, paddingInline: 32, backgroundColor: palette.navy, borderColor: palette.navy }}
        >
          Apply Template & Parse Ledger
        </Button>
      </Space>
    </Space>
    );
  };

  const diffSampleColumns = [
    { title: "Loan Number", dataIndex: "loan_number" },
    { title: "Customer", dataIndex: "customer_name" },
    { title: "Bucket", dataIndex: "bucket", render: (v: string | null) => v ?? "-" },
    {
      title: "Due Amount",
      dataIndex: "due_amount",
      render: (v: number | null) => (v == null ? "-" : v.toLocaleString("en-IN")),
    },
    {
      title: "POS",
      dataIndex: "pos",
      render: (v: number | null) => (v == null ? "-" : v.toLocaleString("en-IN")),
    },
  ];

  const newLoanExtraColumns = [
    { title: "Branch", dataIndex: "branch", render: (v: string | null) => v ?? "-" },
    { title: "Product", dataIndex: "product", render: (v: string | null) => v ?? "-" },
    {
      title: "EMI Due Amount",
      dataIndex: "emi",
      render: (v: number | null) => (v == null ? "-" : v.toLocaleString("en-IN")),
    },
  ];

  const renderStep2 = () => {
    if (!preview) return null;
    const isAllocation = preview.mode === "allocation";

    if (!isAllocation) {
      const canCommit = (preview.valid_rows ?? 0) > 0;
      return (
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <Row gutter={16}>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic title="Total rows" value={preview.total_rows} />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic
                  title="Valid (will insert)"
                  value={preview.valid_rows}
                  valueStyle={{ color: palette.emerald }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic
                  title="Errors (will skip)"
                  value={preview.error_rows}
                  valueStyle={preview.error_rows > 0 ? { color: palette.destructive } : {}}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic
                  title="Already in DB"
                  value={preview.duplicates_in_db}
                  valueStyle={(preview.duplicates_in_db ?? 0) > 0 ? { color: palette.warning } : {}}
                />
              </Card>
            </Col>
          </Row>

          {preview.unmapped_columns.length > 0 && (
            <Alert
              type="info"
              showIcon
              message={`${preview.unmapped_columns.length} unmapped column(s) will be saved as custom fields: ${preview.unmapped_columns.join(", ")}`}
            />
          )}

          {preview.sample_rows && preview.sample_rows.length > 0 && (
            <div>
              <Typography.Text strong>Sample rows (first {preview.sample_rows.length}):</Typography.Text>
              <Table
                rowKey="loan_number"
                size="small"
                style={{ marginTop: 8 }}
                pagination={false}
                dataSource={preview.sample_rows}
                columns={[...diffSampleColumns, ...newLoanExtraColumns]}
              />
            </div>
          )}

          {preview.errors.length > 0 && (
            <div>
              <Typography.Text strong>Row errors (first 50):</Typography.Text>
              <Table
                rowKey="row"
                size="small"
                style={{ marginTop: 8 }}
                pagination={false}
                dataSource={preview.errors}
                columns={[
                  { title: "Row", dataIndex: "row", width: 70 },
                  { title: "Problems", dataIndex: "problems", render: (ps: string[]) => ps.join("; ") },
                ]}
              />
            </div>
          )}

          {!canCommit && (
            <Alert
              type="warning"
              message="No valid rows to insert — check your column mapping or the file data."
              showIcon
            />
          )}

          <Space>
            <Button onClick={() => setStep(1)}>Back to mapping</Button>
            <Button
              type="primary"
              size="large"
              disabled={!canCommit}
              onClick={handleCommit}
              loading={loading}
              style={canCommit ? { height: 48, paddingInline: 32 } : { height: 48 }}
            >
              Commit Import ({preview.valid_rows} rows)
            </Button>
          </Space>
        </Space>
      );
    }

    // Allocation mode: show the actual diff, since additions/removals/
    // reactivations may need review rather than applying immediately.
    const additions = preview.additions ?? { count: 0, sample: [] };
    const removals = preview.removals ?? { count: 0, sample: [] };
    const reactivations = preview.reactivations ?? { count: 0, sample: [] };
    const willUpdate = preview.will_update ?? 0;
    const canCommit = preview.total_rows > preview.error_rows || removals.count > 0;

    return (
      <Space direction="vertical" style={{ width: "100%" }} size="large">
        <Row gutter={16}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic title="Total rows" value={preview.total_rows} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title={preview.is_repeat_import ? "New loans (needs review)" : "New loans (will insert)"}
                value={additions.count}
                valueStyle={{ color: preview.is_repeat_import ? palette.warning : palette.emerald }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic title="Existing loans (will update)" value={willUpdate} valueStyle={{ color: palette.emerald }} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="Missing from file (needs review)"
                value={removals.count}
                valueStyle={removals.count > 0 ? { color: palette.destructive } : {}}
              />
            </Card>
          </Col>
        </Row>

        <Alert
          type={preview.is_repeat_import ? "warning" : "info"}
          showIcon
          message={
            preview.is_repeat_import
              ? `This company already has an allocation on file for this month — this is a repeat/refresh import (allocation files can arrive at any time, not just once a month). New loans, reappearing recalled/closed loans, and missing loans all wait in the Import Review queue for an agency admin or operations manager to decide — nothing is applied automatically.`
              : `First allocation import for this month: new loans insert directly. Any active loan missing from the file still needs review before it can be marked recalled.`
          }
        />

        {reactivations.count > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`${reactivations.count} loan(s) reappearing that were previously recalled/closed — flagged for review as reactivations, not silently reinstated.`}
          />
        )}

        {(preview.new_buckets?.length || preview.new_products?.length) ? (
          <Space direction="vertical" size={4}>
            {preview.new_buckets && preview.new_buckets.length > 0 && (
              <div>
                <Typography.Text type="secondary">New buckets discovered: </Typography.Text>
                {preview.new_buckets.map((b) => (
                  <Tag key={b}>{b}</Tag>
                ))}
              </div>
            )}
            {preview.new_products && preview.new_products.length > 0 && (
              <div>
                <Typography.Text type="secondary">New products discovered: </Typography.Text>
                {preview.new_products.map((p) => (
                  <Tag key={p}>{p}</Tag>
                ))}
              </div>
            )}
          </Space>
        ) : null}

        {additions.sample.length > 0 && (
          <div>
            <Typography.Text strong>New loans (first {additions.sample.length}):</Typography.Text>
            <Table
              rowKey="loan_number"
              size="small"
              style={{ marginTop: 8 }}
              pagination={false}
              dataSource={additions.sample}
              columns={[...diffSampleColumns, ...newLoanExtraColumns]}
            />
          </div>
        )}

        {removals.sample.length > 0 && (
          <div>
            <Typography.Text strong>Missing from file (first {removals.sample.length}):</Typography.Text>
            <Table
              rowKey="loan_number"
              size="small"
              style={{ marginTop: 8 }}
              pagination={false}
              dataSource={removals.sample}
              columns={[
                ...diffSampleColumns,
                { title: "Agent", dataIndex: "agent_name", render: (v: string | null) => v ?? "-" },
              ]}
            />
          </div>
        )}

        {preview.unmapped_columns.length > 0 && (
          <Alert
            type="info"
            showIcon
            message={`${preview.unmapped_columns.length} unmapped column(s) will be saved as custom fields: ${preview.unmapped_columns.join(", ")}`}
          />
        )}

        {preview.errors.length > 0 && (
          <div>
            <Typography.Text strong>Row errors (first 50):</Typography.Text>
            <Table
              rowKey="row"
              size="small"
              style={{ marginTop: 8 }}
              pagination={false}
              dataSource={preview.errors}
              columns={[
                { title: "Row", dataIndex: "row", width: 70 },
                { title: "Problems", dataIndex: "problems", render: (ps: string[]) => ps.join("; ") },
              ]}
            />
          </div>
        )}

        {!canCommit && (
          <Alert
            type="warning"
            message="No valid rows to insert or review — check your column mapping or the file data."
            showIcon
          />
        )}

        <Space>
          <Button onClick={() => setStep(1)}>Back to mapping</Button>
          <Button
            type="primary"
            size="large"
            disabled={!canCommit}
            onClick={handleCommit}
            loading={loading}
            style={canCommit ? { height: 48, paddingInline: 32 } : { height: 48 }}
          >
            Commit Import ({willUpdate + additions.count} rows, {removals.count + reactivations.count} for
            review)
          </Button>
        </Space>
      </Space>
    );
  };

  const renderStep3 = () => {
    if (!result) return null;
    const pendingTotal = result.pending_review + result.removal_flagged;
    return (
      <Space direction="vertical" style={{ width: "100%" }} size="large" align="center">
        <CheckCircleOutlined style={{ fontSize: 64, color: palette.emerald }} />
        <Typography.Title level={3} style={{ margin: 0 }}>
          Import complete
        </Typography.Title>
        <Descriptions bordered size="small" style={{ width: 360 }}>
          <Descriptions.Item label="Inserted" span={3}>
            <span className="money" style={{ color: palette.emerald }}>
              {result.inserted_rows}
            </span>
          </Descriptions.Item>
          {result.updated_rows > 0 && (
            <Descriptions.Item label="Updated" span={3}>
              <span className="money" style={{ color: palette.emerald }}>
                {result.updated_rows}
              </span>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Skipped (duplicate)" span={3}>
            <span className="money">{result.duplicate_rows}</span>
          </Descriptions.Item>
          <Descriptions.Item label="Errors" span={3}>
            <span className="money">{result.error_rows}</span>
          </Descriptions.Item>
        </Descriptions>

        {pendingTotal > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ width: "100%", maxWidth: 560 }}
            message={`${pendingTotal} entr${pendingTotal === 1 ? "y" : "ies"} flagged for review`}
            description="New/reappearing loans and loans missing from this file are waiting on an agency admin or operations manager decision before they take effect."
            action={
              <Button size="small" type="primary" onClick={() => navigate("/import-reviews")}>
                Review now
              </Button>
            }
          />
        )}

        {(result.new_buckets.length > 0 || result.new_products.length > 0) && (
          <Space direction="vertical" size={4} style={{ width: "100%", maxWidth: 560 }}>
            {result.new_buckets.length > 0 && (
              <div>
                <Typography.Text type="secondary">New buckets registered: </Typography.Text>
                {result.new_buckets.map((b) => (
                  <Tag key={b}>{b}</Tag>
                ))}
              </div>
            )}
            {result.new_products.length > 0 && (
              <div>
                <Typography.Text type="secondary">New products registered: </Typography.Text>
                {result.new_products.map((p) => (
                  <Tag key={p}>{p}</Tag>
                ))}
              </div>
            )}
          </Space>
        )}

        {result.unknown_agent_phones?.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`Unknown agent phone(s), loans left with their previous assignee: ${result.unknown_agent_phones.join(", ")}`}
          />
        )}
        <Space>
          <Button onClick={() => navigate("/customers")}>View Customers</Button>
          <Button type="primary" onClick={restart}>
            Import another file
          </Button>
        </Space>
      </Space>
    );
  };

  const stepContent = [renderStep0(), renderStep1(), renderStep2(), renderStep3()];

  return (
    <div>
      <Steps
        current={step}
        style={{ marginBottom: 32 }}
        items={[
          { title: "Select & Upload", icon: <FileExcelOutlined /> },
          { title: "Map Columns" },
          { title: "Preview & Validate" },
          { title: "Done", icon: <CheckCircleOutlined /> },
        ]}
      />
      <Card>{stepContent[step]}</Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Import history tab
// ──────────────────────────────────────────────────────────────────────────────

function ImportHistory() {
  const { hasPermission } = useAuth();
  const canDelete = hasPermission("imports.manage");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [rolling, setRolling] = useState<string | null>(null);

  const deleteRun = async (runId: string) => {
    setDeleting(runId);
    try {
      await api.delete(`/imports/runs/${runId}`);
      message.success("Import run deleted");
      setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, deleted_at: new Date().toISOString() } : r));
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  const rollbackRun = async (runId: string) => {
    setRolling(runId);
    try {
      await api.post(`/imports/runs/${runId}/rollback`);
      message.success("Import rolled back successfully");
      setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, rolled_back_at: new Date().toISOString() } : r));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.includes("blocked:") || msg.includes("Rollback blocked")) {
        const match = msg.match(/(\w+-\d+(?:, \w+-\d+)*)/);
        if (match) {
          const customers = match[1].split(", ");
          message.error(`Cannot rollback: ${customers.length} customer(s) have been worked since. ${customers.join(", ")}`);
        } else {
          message.error(msg);
        }
      } else {
        message.error(msg);
      }
    } finally {
      setRolling(null);
    }
  };

  useEffect(() => {
    api.get("/companies").then((r) => setCompanies(r.data.companies)).catch((err) => message.error(errorMessage(err)));
  }, []);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get("/imports/runs", { params: { company_id: companyId } });
      setRuns(res.data.runs);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <Select
        style={{ width: 320 }}
        title="Select a company to view history" placeholder="Select a company to view history"
        value={companyId}
        onChange={setCompanyId}
        options={companies.map((c) => ({ value: c.id, label: c.name }))}
      />

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
        dataSource={runs}
        pagination={false}
        columns={[
          {
            title: "Date",
            dataIndex: "created_at",
            width: 170,
            render: (v: string) => new Date(v).toLocaleString("en-IN"),
          },
          { title: "File", dataIndex: "file_name", render: (v) => v ?? "—" },
          { title: "Template", dataIndex: "template_name", render: (v) => v ?? "—" },
          { title: "Uploaded by", dataIndex: "uploaded_by_name", render: (v) => v ?? "—" },
          {
            title: "Inserted",
            dataIndex: "inserted_rows",
            width: 90,
            align: "right",
            render: (v: number) => <span className="money" style={{ color: palette.emerald }}>{v}</span>,
          },
          {
            title: "Dupes",
            dataIndex: "duplicate_rows",
            width: 80,
            align: "right",
            render: (v: number) => <span className="money">{v}</span>,
          },
          {
            title: "Errors",
            dataIndex: "error_rows",
            width: 80,
            align: "right",
            render: (v: number) => (
              <span className="money" style={v > 0 ? { color: palette.destructive } : {}}>
                {v}
              </span>
            ),
          },
          {
            title: "Status",
            key: "status",
            width: 110,
            render: (_, r: ImportRun) => {
              if (r.deleted_at) return <Tag color="error">Deleted</Tag>;
              if (r.rolled_back_at) return <Tag color="orange">Rolled back</Tag>;
              if (r.inserted_rows === 0 && r.error_rows === 0)
                return <Tag color="default">All dupes</Tag>;
              if (r.error_rows === 0) return <Tag color="success">Clean</Tag>;
              return <Tag color="warning">Partial</Tag>;
            },
          },
          {
            title: "",
            key: "actions",
            width: 120,
            render: (_, r: ImportRun) => {
              if (!canDelete || r.deleted_at || r.rolled_back_at) return null;

              if (r.mode === "new") {
                return (
                  <Popconfirm
                    title="Delete this import run?"
                    description="This will remove all customers from this run that haven't been assigned or worked. This cannot be undone."
                    onConfirm={() => deleteRun(r.id)}
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      loading={deleting === r.id}
                    />
                  </Popconfirm>
                );
              }

              // allocation-mode: show rollback button
              return (
                <Popconfirm
                  title="Rollback this import run?"
                  description="This will reverse all changes from this import. Blocks if any customer has been worked since."
                  onConfirm={() => rollbackRun(r.id)}
                  okText="Rollback"
                  okButtonProps={{ danger: true }}
                >
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={rolling === r.id}
                  />
                </Popconfirm>
              );
            },
          },
        ]}
      />
    </Space>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Page shell with Tabs
// ──────────────────────────────────────────────────────────────────────────────

export default function ImportPage() {
  return (
    <div>
      <Typography.Title level={3} style={{ marginBottom: 24 }}>
        Data Import
      </Typography.Title>
      <Tabs
        defaultActiveKey="wizard"
        items={[
          {
            key: "wizard",
            label: (
              <Space>
                <CloudUploadOutlined />
                Import Wizard
              </Space>
            ),
            children: <ImportWizard />,
          },
          {
            key: "history",
            label: (
              <Space>
                <HistoryOutlined />
                Import History
              </Space>
            ),
            children: <ImportHistory />,
          },
        ]}
      />
    </div>
  );
}
