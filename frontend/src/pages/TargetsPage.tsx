import {
  Button,
  DatePicker,
  Empty,
  InputNumber,
  Radio,
  Space,
  Switch,
  Table,
  Typography,
  Upload,
  message,
} from "antd";
import { SaveOutlined, UploadOutlined } from "@ant-design/icons";
import type { RcFile } from "antd/es/upload";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api/client";

const METRICS = ["collection", "resolution", "rollback", "normalization", "recovery"] as const;
type Metric = (typeof METRICS)[number];
type ScopeType = "agency" | "branch" | "team" | "agent";

const METRIC_LABELS: Record<Metric, string> = {
  collection: "Collection",
  resolution: "Resolution",
  rollback: "Roll Back",
  normalization: "Normalization",
  recovery: "Recovery",
};

type ScopeEntity = { scope_id: string | null; name: string };
type TargetRow = {
  metric: Metric;
  scope_type: ScopeType;
  scope_id: string | null;
  target_amount: string | null;
  target_count: number | null;
};
type BookTotal = { scope_id: string | null; count: number; emi_total: number; pos_total: number };

/** ₹ with thousands separators, no decimals -- matches the InputNumber formatter below. */
const formatRupees = (n: number) => `₹ ${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/**
 * Monthly target entry (Phase 5): month + scope level -> one editable row per
 * entity with a column per metric. Values feed the dashboard's Target /
 * Target % / Required run-rate. Amount and Count are edited separately via
 * the toggle. Blanking a cell removes that target.
 */
export default function TargetsPage() {
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [scopeType, setScopeType] = useState<ScopeType>("agent");
  const [amountMode, setAmountMode] = useState(true);
  const [entities, setEntities] = useState<ScopeEntity[]>([]);
  const [saved, setSaved] = useState<TargetRow[]>([]);
  const [edits, setEdits] = useState<Record<string, number | null>>({});
  const [bookTotals, setBookTotals] = useState<Record<string, BookTotal>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const cellKey = (scopeId: string | null, metric: Metric) => `${scopeId ?? "agency"}:${metric}`;

  useEffect(() => {
    if (scopeType === "agency") {
      setEntities([{ scope_id: null, name: "Whole agency" }]);
      return;
    }
    const source = {
      branch: async () =>
        (await api.get("/branches")).data.branches.map((b: { id: string; name: string }) => ({
          scope_id: b.id,
          name: b.name,
        })),
      team: async () =>
        (await api.get("/teams")).data.teams.map((t: { id: string; name: string }) => ({
          scope_id: t.id,
          name: t.name,
        })),
      agent: async () =>
        (await api.get("/employees")).data.employees
          .filter(
            (e: { is_active: boolean; is_telecaller: boolean; is_field_agent: boolean }) =>
              e.is_active && (e.is_telecaller || e.is_field_agent),
          )
          .map((e: { id: string; full_name: string }) => ({ scope_id: e.id, name: e.full_name })),
    }[scopeType];
    source().then(setEntities).catch((err) => message.error(errorMessage(err)));
  }, [scopeType]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/targets", {
        params: { month: month.format("YYYY-MM"), scope_type: scopeType },
      });
      setSaved(res.data.targets);
      setEdits({});
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [month, scopeType]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Phase 8: the book size (SUM(emi)/SUM(pos)) per entity at this scope
   * level -- shown alongside the Collection column so admins can see what
   * the computed-default target would be while entering manual ones.
   */
  useEffect(() => {
    api
      .get("/targets/book-totals", { params: { month: month.format("YYYY-MM"), scope_type: scopeType } })
      .then((res) => {
        const map: Record<string, BookTotal> = {};
        for (const t of res.data.totals as BookTotal[]) {
          map[t.scope_id ?? "agency"] = t;
        }
        setBookTotals(map);
      })
      .catch((err) => message.error(errorMessage(err)));
  }, [month, scopeType]);

  const savedValue = useCallback(
    (scopeId: string | null, metric: Metric): number | null => {
      const row = saved.find((t) => (t.scope_id ?? null) === scopeId && t.metric === metric);
      if (!row) return null;
      const v = amountMode ? row.target_amount : row.target_count;
      return v == null ? null : Number(v);
    },
    [saved, amountMode],
  );

  const currentValue = (scopeId: string | null, metric: Metric): number | null => {
    const key = cellKey(scopeId, metric);
    return key in edits ? edits[key] : savedValue(scopeId, metric);
  };

  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const rows = Object.entries(edits).map(([key, value]) => {
        const [scopeIdPart, metric] = key.split(":") as [string, Metric];
        const scopeId = scopeIdPart === "agency" ? null : scopeIdPart;
        const existing = saved.find(
          (t) => (t.scope_id ?? null) === scopeId && t.metric === metric,
        );
        // Only the toggled field changes; the other keeps its saved value.
        const amount = amountMode
          ? value
          : existing?.target_amount != null
            ? Number(existing.target_amount)
            : null;
        const count = amountMode
          ? existing?.target_count != null
            ? Number(existing.target_count)
            : null
          : value;
        return {
          metric,
          scope_type: scopeType,
          scope_id: scopeId,
          target_amount: amount,
          target_count: count,
        };
      });
      const res = await api.put("/targets/bulk", { month: month.format("YYYY-MM"), rows });
      message.success(`Saved ${res.data.upserted} target(s)${res.data.deleted ? `, removed ${res.data.deleted}` : ""}`);
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const importExcel = async (file: RcFile) => {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await api.post("/targets/import", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      if (res.data.error_rows > 0) {
        message.warning(
          `Imported ${res.data.imported} target(s); ${res.data.error_rows} row(s) had problems: ` +
            res.data.errors
              .slice(0, 3)
              .map((e: { row: number; problem: string }) => `row ${e.row}: ${e.problem}`)
              .join(" · "),
        );
      } else {
        message.success(`Imported ${res.data.imported} target(s)`);
      }
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    }
    return false;
  };

  const columns = useMemo(
    () => [
      { title: scopeType === "agent" ? "Agent" : scopeType === "team" ? "Team" : scopeType === "branch" ? "Branch" : "Scope", dataIndex: "name", fixed: "left" as const, width: 200 },
      {
        title: "Portfolio (POS)",
        width: 160,
        render: (_: unknown, entity: ScopeEntity) => {
          const book = bookTotals[entity.scope_id ?? "agency"];
          if (!book || book.count === 0) return <Typography.Text type="secondary">—</Typography.Text>;
          return (
            <Typography.Text type="secondary">
              {formatRupees(book.pos_total)}
              <br />
              <span style={{ fontSize: 11 }}>{book.count} loan(s)</span>
            </Typography.Text>
          );
        },
      },
      ...METRICS.map((metric) => ({
        title: METRIC_LABELS[metric],
        width: 150,
        render: (_: unknown, entity: ScopeEntity) => {
          const book = bookTotals[entity.scope_id ?? "agency"];
          // Collection's computed-default tier (Phase 8) is SUM(emi) over
          // this entity's book -- surfaced as a placeholder so admins can
          // see what applies automatically when a cell is left blank.
          const defaultHint =
            metric === "collection" && amountMode && book && book.count > 0
              ? `Default: ${formatRupees(book.emi_total)}`
              : "—";
          return (
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              placeholder={defaultHint}
              value={currentValue(entity.scope_id, metric)}
              formatter={
                amountMode
                  ? (v) => (v === undefined || v === null || v === ("" as never) ? "" : `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ","))
                  : undefined
              }
              parser={amountMode ? (v) => Number((v ?? "").replace(/[₹,\s]/g, "")) as never : undefined}
              onChange={(v) =>
                setEdits((prev) => ({
                  ...prev,
                  [cellKey(entity.scope_id, metric)]: v === null || v === undefined ? null : Number(v),
                }))
              }
            />
          );
        },
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeType, amountMode, edits, saved, bookTotals],
  );

  return (
    <div>
      <Typography.Title level={4}>Monthly Targets</Typography.Title>
      <Typography.Paragraph type="secondary">
        Targets drive the dashboard's Target %, gauge and required run-rate. Set them per agent,
        team, branch, or for the whole agency. Clearing a cell removes that target.
      </Typography.Paragraph>

      <Space wrap style={{ marginBottom: 16 }}>
        <DatePicker
          picker="month"
          allowClear={false}
          value={month}
          onChange={(m) => m && setMonth(m)}
        />
        <Radio.Group
          value={scopeType}
          onChange={(e) => setScopeType(e.target.value)}
          options={[
            { value: "agent", label: "Per agent" },
            { value: "team", label: "Per team" },
            { value: "branch", label: "Per branch" },
            { value: "agency", label: "Agency" },
          ]}
          optionType="button"
        />
        <Space>
          <Typography.Text type="secondary">Count</Typography.Text>
          <Switch checked={amountMode} onChange={setAmountMode} />
          <Typography.Text type="secondary">Amount (₹)</Typography.Text>
        </Space>
        <Upload accept=".xlsx" showUploadList={false} beforeUpload={importExcel}>
          <Button icon={<UploadOutlined />}>Import Excel</Button>
        </Upload>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          disabled={!dirty}
          loading={saving}
          onClick={save}
        >
          Save changes
        </Button>
      </Space>

      <Table<ScopeEntity>
        rowKey={(e) => e.scope_id ?? "agency"}
        loading={loading}
        dataSource={entities}
        columns={columns}
        // Each row here is a branch/team/agent to enter a target against --
        // an empty table means none of those exist yet for this scope, not
        // "no targets set." Point at where to create one.
        locale={{
          emptyText: (
            <Empty
              description={
                scopeType === "branch"
                  ? "No branches yet"
                  : scopeType === "team"
                    ? "No teams yet"
                    : "No employees yet"
              }
            >
              {scopeType !== "agency" && (
                <Link to={scopeType === "branch" ? "/branches" : scopeType === "team" ? "/teams" : "/employees"}>
                  <Button type="primary">
                    Add {scopeType === "branch" ? "a branch" : scopeType === "team" ? "a team" : "an employee"}
                  </Button>
                </Link>
              )}
            </Empty>
          ),
        }}
        pagination={false}
        scroll={{ x: 1110 }}
        size="small"
      />
    </div>
  );
}
