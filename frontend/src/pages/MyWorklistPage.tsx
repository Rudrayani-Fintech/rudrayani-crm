import { Alert, Badge, Button, Collapse, Input, Modal, Select, Space, Table, Tag, Typography, message, theme } from "antd";
import { CalendarOutlined, DollarOutlined, EditOutlined, EnvironmentOutlined, FileTextOutlined, PhoneOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import CustomerDetailDrawer from "../components/CustomerDetailDrawer";
import EditRemarkModal, { canDirectEditRecord, type DirectEditableKind } from "../components/EditRemarkModal";
import LogCallModal from "../components/LogCallModal";
import RecordPaymentModal from "../components/RecordPaymentModal";
import ReportCorrectionModal, { type CorrectableRecordType } from "../components/ReportCorrectionModal";
import { bucketSeverityColor, useBucketSeverity } from "../hooks/useBucketSeverity";
import { useWorkScope } from "../scope/WorkScopeContext";
import { palette } from "../theme/tokens";
import { rupees as fmtAmount } from "../utils/money";
import type { DispositionCode, WorklistCustomer } from "../types";

dayjs.extend(relativeTime);

const FILTER_STORAGE_PREFIX = "rcrm_worklist_filters_";

function loadPersistedFilters(userId: string | undefined): { branches: string[]; buckets: string[] } {
  if (!userId) return { branches: [], buckets: [] };
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_PREFIX + userId);
    if (!raw) return { branches: [], buckets: [] };
    const parsed = JSON.parse(raw) as { branches?: string[]; buckets?: string[] };
    return { branches: parsed.branches ?? [], buckets: parsed.buckets ?? [] };
  } catch {
    return { branches: [], buckets: [] };
  }
}

function savePersistedFilters(userId: string | undefined, branches: string[], buckets: string[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(FILTER_STORAGE_PREFIX + userId, JSON.stringify({ branches, buckets }));
  } catch {
    // Private browsing / storage disabled -- filters still work for this session.
  }
}

interface ReminderDue {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  loan_number: string | null;
  note: string | null;
  remind_at: string;
}

interface PtpDue {
  id: string;
  customer_id: string;
  customer_name: string;
  loan_number: string;
  amount: string;
  promised_date: string;
}

interface AgentActivityRow {
  kind: "call" | "payment" | "ptp" | "field_visit";
  id: string;
  at: string;
  agent_id: string;
  agent_name?: string | null;
  customer_id: string;
  customer_name: string;
  loan_number: string;
  remark: string | null;
  extra_remark: string | null;
  amount: string | null;
  detail: string | null;
  edited_at: string | null;
}

const ACTIVITY_ICON: Record<AgentActivityRow["kind"], React.ReactNode> = {
  call: <PhoneOutlined style={{ color: "#1677ff" }} />,
  payment: <DollarOutlined style={{ color: "#52c41a" }} />,
  ptp: <FileTextOutlined style={{ color: "#faad14" }} />,
  field_visit: <EnvironmentOutlined style={{ color: "#722ed1" }} />,
};

const ACTIVITY_LABEL: Record<AgentActivityRow["kind"], string> = {
  call: "Call",
  payment: "Payment",
  ptp: "PTP",
  field_visit: "Field Visit",
};

const CORRECTABLE_KIND: Partial<Record<AgentActivityRow["kind"], CorrectableRecordType>> = {
  call: "call_log",
  payment: "payment",
  ptp: "ptp",
  field_visit: "field_visit",
};

// Same-day (rolling 24h) owner-only direct edit -- distinct from the
// correction-request flow above (manager-approved, no time limit). Only
// calls and field visits carry a free-text remark that's worth editing this
// way; payments/PTPs still go through "Report an error" only.
const DIRECT_EDIT_KIND: Partial<Record<AgentActivityRow["kind"], DirectEditableKind>> = {
  call: "call",
  field_visit: "field_visit",
};

function canDirectEdit(a: AgentActivityRow, userId: string | undefined): boolean {
  if (!DIRECT_EDIT_KIND[a.kind]) return false;
  return canDirectEditRecord(a.at, a.agent_id, userId);
}

/**
 * A telecaller/field agent's own worklist on web -- the properly-scoped
 * equivalent of the (now hidden-for-this-persona) generic Customers page.
 * Complements the mobile app rather than duplicating it: same data
 * (GET /worklist), but a denser table suited to a desk/keyboard.
 */
export default function MyWorklistPage() {
  // palette.border below used to be the static, light-mode-only value --
  // in dark mode this list-item divider stayed light-gray on a dark
  // surface, mismatching every other border on the page. token.useToken()
  // resolves to whichever mode is actually active (see SummaryStat.tsx for
  // the same fix applied to a card background).
  const { token } = theme.useToken();
  const bucketSeverity = useBucketSeverity();
  const { user } = useAuth();
  const isBranchManager = !!user?.capabilities.includes("branch_manager");

  const [customers, setCustomers] = useState<WorklistCustomer[]>([]);
  const [reminders, setReminders] = useState<ReminderDue[]>([]);
  const [ptpsDue, setPtpsDue] = useState<PtpDue[]>([]);
  const [filterOptions, setFilterOptions] = useState<{ branches: string[]; buckets: string[] }>({
    branches: [],
    buckets: [],
  });
  const [products, setProducts] = useState<{ raw_label: string; canonical_label: string }[]>([]);

  const [search, setSearch] = useState("");
  const [filterCompany, setFilterCompany] = useState<string | undefined>();
  // Lazy initializers: MyWorklistPage only ever mounts once RequireAuth's
  // `loading` gate has cleared (see App.tsx), so `user` is already resolved
  // at this component's first render -- hydrating synchronously here means
  // `load` below is correctly filtered from its very first identity, with
  // no separate post-mount hydration effect racing the initial /worklist
  // fetch (which previously caused either a lost selection or a flash of
  // the unfiltered list depending on effect ordering).
  const [filterCustomerBranches, setFilterCustomerBranches] = useState<string[]>(
    () => loadPersistedFilters(user?.id).branches,
  );
  const [filterProduct, setFilterProduct] = useState<string | undefined>();
  const [filterBuckets, setFilterBuckets] = useState<string[]>(() => loadPersistedFilters(user?.id).buckets);
  // Driven by the one app-level "My Team ↔ My Work" switch in AppLayout's
  // header (see WorkScopeContext) instead of its own Segmented control --
  // usage below stays gated on isBranchManager, so this has no effect for
  // a dual-capability team_lead flipping the same header switch.
  const { myWorkOnly } = useWorkScope();
  const scope: "personal" | "team" = myWorkOnly ? "personal" : "team";

  // Companies actually present in the worklist -- cheap client-side derivation
  // (mirrors the mobile app's same approach), no new endpoint. Company itself
  // is filtered client-side too (below), so this list never shrinks out from
  // under the dropdown the way a server-filtered derivation would.
  const companyOptions = useMemo(() => {
    const names = Array.from(new Set(customers.map((c) => c.company_name))).sort();
    return names.map((name) => ({ value: name, label: name }));
  }, [customers]);

  const displayedCustomers = useMemo(
    () => (filterCompany ? customers.filter((c) => c.company_name === filterCompany) : customers),
    [customers, filterCompany],
  );

  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dispositionCodes, setDispositionCodes] = useState<DispositionCode[]>([]);
  const [logCallTarget, setLogCallTarget] = useState<WorklistCustomer | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<WorklistCustomer | null>(null);
  const [reallocTarget, setReallocTarget] = useState<WorklistCustomer | null>(null);
  const [reallocReason, setReallocReason] = useState("");
  const [reallocSubmitting, setReallocSubmitting] = useState(false);

  // Today's Work
  const [todayActivity, setTodayActivity] = useState<AgentActivityRow[]>([]);
  const [todayLoading, setTodayLoading] = useState(false);
  const todayScope: "personal" | "branch" = myWorkOnly ? "personal" : "branch";
  const [todayDisposition, setTodayDisposition] = useState<string | undefined>();
  const [correctionTarget, setCorrectionTarget] = useState<AgentActivityRow | null>(null);
  const [editRemarkTarget, setEditRemarkTarget] = useState<AgentActivityRow | null>(null);

  const loadTodayActivity = useCallback(async () => {
    setTodayLoading(true);
    try {
      const params: Record<string, string | number | boolean> = { today: true, limit: 200 };
      if (isBranchManager && todayScope === "branch") params.scope = "team";
      if (todayDisposition) params.disposition_code_id = todayDisposition;
      const res = await api.get("/reports/agent-activity", { params });
      setTodayActivity(res.data.activity);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setTodayLoading(false);
    }
  }, [isBranchManager, todayScope, todayDisposition]);

  useEffect(() => {
    void loadTodayActivity();
  }, [loadTodayActivity]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const today = dayjs().format("YYYY-MM-DD");
      const params: Record<string, string> = {};
      if (search) params.q = search;
      if (filterCustomerBranches.length > 0) params.customer_branch = filterCustomerBranches.join(",");
      if (filterProduct) params.product = filterProduct;
      if (filterBuckets.length > 0) params.bucket = filterBuckets.join(",");
      if (isBranchManager && scope === "team") params.scope = "team";

      const [worklistRes, remindersRes, ptpsRes] = await Promise.all([
        api.get("/worklist", { params }),
        api.get("/reminders", { params: { status: "pending", date: today } }),
        api.get("/ptps/due", { params: { date: today } }),
      ]);
      setCustomers(worklistRes.data.customers);
      setReminders(remindersRes.data.reminders);
      setPtpsDue(ptpsRes.data.ptps);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, filterCustomerBranches, filterProduct, filterBuckets, isBranchManager, scope]);

  useEffect(() => {
    api.get("/dispositions").then((res) => setDispositionCodes(res.data.disposition_codes)).catch((err) => message.error(errorMessage(err)));
    api.get("/products").then((res) => setProducts(res.data.products)).catch((err) => message.error(errorMessage(err)));
  }, []);

  useEffect(() => {
    const params = isBranchManager && scope === "team" ? { scope: "team" } : undefined;
    api
      .get("/worklist/filter-options", { params })
      .then((res) => setFilterOptions({ branches: res.data.branches, buckets: res.data.buckets }))
      .catch((err) => message.error(errorMessage(err)));
  }, [isBranchManager, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const dueCount = reminders.length + ptpsDue.length;

  const submitReallocation = async () => {
    if (!reallocTarget) return;
    if (reallocReason.trim().length < 3) {
      message.error("Please explain why (at least a few words)");
      return;
    }
    setReallocSubmitting(true);
    try {
      await api.post("/reallocation-requests", {
        customer_id: reallocTarget.id,
        reason: reallocReason.trim(),
      });
      message.success("Request sent — your team leader will review it");
      setReallocTarget(null);
      setReallocReason("");
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setReallocSubmitting(false);
    }
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        My Worklist
      </Typography.Title>
      <Typography.Text type="secondary">
        {displayedCustomers.length} customers {scope === "team" ? "assigned to your team" : "assigned to you"}
      </Typography.Text>

      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Input.Search
          // The backend's /worklist ?q= already ILIKEs both customer_name
          // and loan_number (worklist.ts) -- the placeholder just hadn't
          // caught up, so agents didn't know loan-number search worked.
          placeholder="Search name or loan number..."
          allowClear
          onSearch={(v) => setSearch(v)}
          style={{ width: 240 }}
        />
        <Select
          title="All companies" placeholder="All companies"
          allowClear
          style={{ width: 180 }}
          value={filterCompany}
          onChange={(v) => setFilterCompany(v ?? undefined)}
          options={companyOptions}
        />
        <Select
          mode="multiple"
          title="All branches" placeholder="All branches"
          allowClear
          showSearch
          style={{ width: 220 }}
          value={filterCustomerBranches}
          onChange={(v) => {
            setFilterCustomerBranches(v);
            savePersistedFilters(user?.id, v, filterBuckets);
          }}
          options={filterOptions.branches.map((b) => ({ value: b, label: b }))}
          maxTagCount="responsive"
        />
        <Select
          title="All products" placeholder="All products"
          allowClear
          style={{ width: 160 }}
          value={filterProduct}
          onChange={(v) => setFilterProduct(v ?? undefined)}
          options={Array.from(new Set(products.map((p) => p.raw_label))).map((label) => ({
            value: label,
            label,
          }))}
        />
        <Select
          mode="multiple"
          title="All buckets" placeholder="All buckets"
          allowClear
          style={{ width: 180 }}
          value={filterBuckets}
          onChange={(v) => {
            setFilterBuckets(v);
            savePersistedFilters(user?.id, filterCustomerBranches, v);
          }}
          options={filterOptions.buckets.map((b) => ({ value: b, label: b }))}
          maxTagCount="responsive"
        />
      </div>

      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <Collapse
          defaultActiveKey={dueCount > 0 ? ["due"] : []}
          items={[
            {
              key: "due",
              label: (
                <Space>
                  <span>Due Today</span>
                  <Badge count={dueCount} showZero={false} style={{ backgroundColor: palette.warning }} />
                </Space>
              ),
              children:
                dueCount === 0 ? (
                  <Typography.Text type="secondary">Nothing due today.</Typography.Text>
                ) : (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    {ptpsDue.map((p) => (
                      <Alert
                        key={p.id}
                        type={dayjs(p.promised_date).isBefore(dayjs(), "day") ? "error" : "warning"}
                        showIcon
                        icon={<CalendarOutlined />}
                        message={`PTP: ${p.customer_name} — ${fmtAmount(p.amount)} by ${dayjs(p.promised_date).format("DD MMM")}`}
                        action={
                          <Button size="small" onClick={() => setDetailId(p.customer_id)}>
                            View
                          </Button>
                        }
                      />
                    ))}
                    {reminders.map((r) => (
                      <Alert
                        key={r.id}
                        type="info"
                        showIcon
                        message={
                          r.customer_name
                            ? `${r.customer_name} (${r.loan_number}) — ${r.note ?? "Reminder"}`
                            : (r.note ?? "Reminder")
                        }
                        description={dayjs(r.remind_at).format("HH:mm")}
                        action={
                          r.customer_id ? (
                            <Button size="small" onClick={() => setDetailId(r.customer_id)}>
                              View
                            </Button>
                          ) : undefined
                        }
                      />
                    ))}
                  </Space>
                ),
            },
          ]}
        />
      </div>

      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <Collapse
          items={[
            {
              key: "today",
              label: (
                <Space>
                  <span>Today's Work</span>
                  <Badge count={todayActivity.length} showZero style={{ backgroundColor: palette.navy }} />
                </Space>
              ),
              children: (
                <Space direction="vertical" style={{ width: "100%" }} size="middle">
                  <Space wrap onClick={(e) => e.stopPropagation()}>
                    <Select
                      title="All dispositions" placeholder="Filter by disposition code"
                      allowClear
                      showSearch
                      style={{ width: 220 }}
                      value={todayDisposition}
                      onChange={(v) => setTodayDisposition(v ?? undefined)}
                      optionFilterProp="label"
                      options={dispositionCodes.map((d) => ({ value: d.id, label: d.action_code }))}
                    />
                  </Space>
                  {todayActivity.length === 0 ? (
                    <Typography.Text type="secondary">
                      {todayLoading ? "Loading…" : "Nothing logged yet today."}
                    </Typography.Text>
                  ) : (
                    <Space direction="vertical" style={{ width: "100%" }} size="small">
                      {todayActivity.map((a) => (
                        <div
                          key={`${a.kind}-${a.id}`}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 12,
                            padding: "8px 12px",
                            border: `1px solid ${token.colorBorderSecondary}`,
                            borderRadius: 6,
                          }}
                        >
                          <Space direction="vertical" size={0} style={{ flex: 1 }}>
                            <Space size={6} wrap>
                              {ACTIVITY_ICON[a.kind]}
                              <Typography.Text strong>{ACTIVITY_LABEL[a.kind]}</Typography.Text>
                              <Tag>{a.customer_name}</Tag>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {a.loan_number}
                              </Typography.Text>
                              {a.agent_name && <Tag color="blue">{a.agent_name}</Tag>}
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {dayjs(a.at).format("HH:mm")}
                              </Typography.Text>
                              {a.edited_at && (
                                <Tag color="default" style={{ fontSize: 11 }}>
                                  edited {dayjs(a.edited_at).format("HH:mm")}
                                </Tag>
                              )}
                            </Space>
                            {a.remark && <Typography.Text>{a.remark}</Typography.Text>}
                            {a.amount != null && (
                              <Typography.Text className="money">₹ {fmtAmount(a.amount)}</Typography.Text>
                            )}
                            {a.detail && !a.remark && (
                              <Typography.Text type="secondary">{a.detail}</Typography.Text>
                            )}
                          </Space>
                          <Space>
                            <Button size="small" onClick={() => setDetailId(a.customer_id)}>
                              View Customer
                            </Button>
                            {/* Correction requests are strictly self-service (POST
                                /correction-requests requires the record's own
                                agent_id to match the caller) -- showing Edit on a
                                teammate's row in Branch scope would just 404. */}
                            {canDirectEdit(a, user?.id) ? (
                              <Button size="small" icon={<EditOutlined />} onClick={() => setEditRemarkTarget(a)}>
                                Edit
                              </Button>
                            ) : (
                              CORRECTABLE_KIND[a.kind] &&
                              a.agent_id === user?.id && (
                                <Button size="small" icon={<EditOutlined />} onClick={() => setCorrectionTarget(a)}>
                                  Edit
                                </Button>
                              )
                            )}
                          </Space>
                        </div>
                      ))}
                    </Space>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Table<WorklistCustomer>
        rowKey="id"
        loading={loading}
        dataSource={displayedCustomers}
        pagination={{ pageSize: 50 }}
        locale={{ emptyText: "No customers assigned to you right now" }}
        onRow={(record) => ({
          onClick: () => setDetailId(record.id),
          style: { cursor: "pointer" },
        })}
        scroll={{ x: scope === "team" ? 1840 : 1700 }}
        columns={[
          {
            title: "Loan No",
            dataIndex: "loan_number",
            width: 120,
            render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
          },
          { title: "Customer", dataIndex: "customer_name", width: 160, ellipsis: true },
          { title: "Company", dataIndex: "company_name", width: 130, ellipsis: true },
          { title: "Branch", dataIndex: "branch_name", width: 110, render: (v) => v ?? "-" },
          ...(scope === "team"
            ? [
                {
                  title: "Agent",
                  key: "agent",
                  width: 140,
                  render: (_: unknown, r: WorklistCustomer) =>
                    r.assigned_field_agent_name || r.assigned_agent_name || "-",
                },
              ]
            : []),
          {
            title: "Mobile",
            dataIndex: "mobile_number",
            width: 130,
            render: (v: string | null) => (v ? <><PhoneOutlined /> {v}</> : "-"),
          },
          { title: "Product", dataIndex: "product", width: 110, render: (v) => v ?? "-" },
          {
            title: "Bucket",
            dataIndex: "bucket",
            width: 80,
            render: (v: string | null) => (v ? <Tag color={bucketSeverityColor(v, bucketSeverity)}>{v}</Tag> : "-"),
          },
          {
            title: "Due Amount",
            dataIndex: "due_amount",
            width: 120,
            align: "right" as const,
            render: (v: string | null) => <span className="money">{fmtAmount(v)}</span>,
          },
          {
            title: "EMI",
            dataIndex: "emi",
            width: 120,
            align: "right" as const,
            render: (v: string | null) => <span className="money">{fmtAmount(v)}</span>,
          },
          {
            title: "Last Activity",
            width: 220,
            render: (_, r) =>
              r.last_call_at ? (
                <span>
                  <Tag>{r.last_result_code ?? "Logged"}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {" "}
                    {dayjs(r.last_call_at).fromNow()}
                  </Typography.Text>
                </span>
              ) : (
                <Typography.Text type="secondary">No calls yet</Typography.Text>
              ),
          },
          {
            title: "PTP",
            width: 140,
            render: (_, r) =>
              r.ptp_date ? (
                <span>
                  {fmtAmount(r.ptp_amount)}
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(r.ptp_date).format("DD MMM")}
                  </Typography.Text>
                </span>
              ) : (
                "-"
              ),
          },
          {
            title: "Actions",
            width: 260,
            render: (_, r) => (
              <Space onClick={(e) => e.stopPropagation()}>
                <Button size="small" onClick={() => setLogCallTarget(r)}>
                  Log Call
                </Button>
                <Button size="small" onClick={() => setPaymentTarget(r)}>
                  Payment
                </Button>
                {/* POST /reallocation-requests requires assigned_agent_id ===
                    caller -- in Team scope most rows belong to a teammate, so
                    Reallocate would just 403 there. is_primary_for_me is
                    always computed relative to the actual caller, regardless
                    of scope, so this also correctly covers a plain agent
                    viewing a customer they're only the field agent for. */}
                {r.is_primary_for_me && (
                  <Button
                    size="small"
                    onClick={() => {
                      setReallocReason("");
                      setReallocTarget(r);
                    }}
                  >
                    Reallocate
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <CustomerDetailDrawer
        customerId={detailId}
        open={detailId !== null}
        onClose={() => {
          setDetailId(null);
          void load();
          void loadTodayActivity();
        }}
      />

      {logCallTarget && (
        <LogCallModal
          customerId={logCallTarget.id}
          customerName={logCallTarget.customer_name}
          dispositionCodes={dispositionCodes}
          open={logCallTarget !== null}
          onClose={() => setLogCallTarget(null)}
          onSaved={load}
        />
      )}
      {paymentTarget && (
        <RecordPaymentModal
          customerId={paymentTarget.id}
          customerName={paymentTarget.customer_name}
          dueAmount={paymentTarget.due_amount != null ? Number(paymentTarget.due_amount) : null}
          open={paymentTarget !== null}
          onClose={() => setPaymentTarget(null)}
          onSaved={load}
        />
      )}

      <Modal
        title={`Request Reallocation — ${reallocTarget?.customer_name ?? ""}`}
        open={!!reallocTarget}
        onCancel={() => setReallocTarget(null)}
        onOk={submitReallocation}
        confirmLoading={reallocSubmitting}
        okText="Send Request"
      >
        <Typography.Paragraph type="secondary">
          Your team lead will review this — nothing changes until they decide. Check My Requests for the
          outcome.
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          placeholder="Why should this customer be moved? (wrong area, language, dispute…)"
          value={reallocReason}
          onChange={(e) => setReallocReason(e.target.value)}
        />
      </Modal>

      {correctionTarget && CORRECTABLE_KIND[correctionTarget.kind] && (
        <ReportCorrectionModal
          recordType={CORRECTABLE_KIND[correctionTarget.kind]!}
          recordId={correctionTarget.id}
          currentValues={
            correctionTarget.kind === "call"
              ? { remark: correctionTarget.remark ?? "" }
              : correctionTarget.kind === "payment"
                ? { amount: Number(correctionTarget.amount), mode: correctionTarget.detail, paid_at: correctionTarget.at }
                : correctionTarget.kind === "field_visit"
                  ? { remark: correctionTarget.remark ?? "" }
                  : { amount: Number(correctionTarget.amount), promised_date: correctionTarget.detail }
          }
          open={correctionTarget !== null}
          onClose={() => setCorrectionTarget(null)}
          onSubmitted={() => {
            setCorrectionTarget(null);
            void loadTodayActivity();
          }}
        />
      )}

      {editRemarkTarget && DIRECT_EDIT_KIND[editRemarkTarget.kind] && (
        <EditRemarkModal
          kind={DIRECT_EDIT_KIND[editRemarkTarget.kind]!}
          recordId={editRemarkTarget.id}
          currentText={
            editRemarkTarget.kind === "call"
              ? (editRemarkTarget.extra_remark ?? "")
              : (editRemarkTarget.remark ?? "")
          }
          open={editRemarkTarget !== null}
          onClose={() => setEditRemarkTarget(null)}
          onSaved={() => {
            setEditRemarkTarget(null);
            void loadTodayActivity();
          }}
        />
      )}
    </div>
  );
}
