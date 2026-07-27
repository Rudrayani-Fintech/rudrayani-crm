import {
  Alert,
  Button,
  Col,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import { HistoryOutlined, UserSwitchOutlined, PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { AllocationLog, Company, Customer, Employee } from "../types";
import CustomerDetailDrawer from "../components/CustomerDetailDrawer";

interface Product {
  id: string;
  raw_label: string;
  canonical_label: string;
}

const fmtAmount = (v: string | null) =>
  v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 });

/** Shared column set for both queues. */
const getBaseColumns = (onOpenDetail: (customerId: string) => void) => [
  {
    title: "",
    key: "details",
    width: 40,
    render: (_: unknown, record: Customer) => (
      <Button
        type="text"
        icon={<PlusOutlined />}
        title="View Details"
        onClick={() => onOpenDetail(record.id)}
      />
    ),
  },
  {
    title: "Loan No",
    dataIndex: "loan_number",
    width: 130,
    render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
  },
  { title: "Customer", dataIndex: "customer_name", width: 160, ellipsis: true },
  { title: "Company", dataIndex: "company_name", width: 150, ellipsis: true },
  { title: "Branch", dataIndex: "branch_name", width: 120, render: (v: string | null) => v ?? "—" },
  {
    title: "Product",
    dataIndex: "product",
    width: 120,
    render: (v: string | null) => (v ? <Tag>{v}</Tag> : "—"),
  },
  {
    title: "Bucket",
    dataIndex: "bucket",
    width: 80,
    render: (v: string | null) => (v ? <Tag color="orange">{v}</Tag> : "—"),
  },
  {
    title: "Due Amount",
    dataIndex: "due_amount",
    width: 130,
    align: "right" as const,
    render: (v: string | null) => <span className="money">{fmtAmount(v)}</span>,
  },
  {
    title: "POS",
    dataIndex: "pos",
    width: 130,
    align: "right" as const,
    render: (v: string | null) => <span className="money">{fmtAmount(v)}</span>,
  },
];

interface Branch { id: string; name: string; branch_manager_id?: string | null }
interface Team { id: string; name: string; branch_id: string }

/**
 * The backend now hard-clamps a branch_manager to their own branch on every
 * allocation action (see resolveBranchClamp() on the API side) -- this just
 * keeps the dropdowns from offering branches/teams that would silently
 * no-op or 404 on submit. Purely a UX narrowing; the actual restriction
 * lives server-side regardless of what this returns.
 */
function useBranchTeam() {
  const { user } = useAuth();
  const isBranchManager = !!user?.capabilities.includes("branch_manager");

  const [allBranches, setAllBranches] = useState<Branch[]>([]);
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api.get("/branches"), api.get("/teams")]).then(([br, tm]) => {
      setAllBranches(br.data.branches);
      setAllTeams(tm.data.teams);
    }).catch((err) => message.error(errorMessage(err)));
  }, []);

  const branches = useMemo(
    () => (isBranchManager ? allBranches.filter((b) => b.branch_manager_id === user?.id) : allBranches),
    [allBranches, isBranchManager, user?.id],
  );

  // Auto-lock a branch_manager onto their own (only) branch -- there's
  // nothing else to pick, and this makes the team dropdown below narrow
  // correctly without an extra click.
  useEffect(() => {
    if (isBranchManager && branches.length === 1 && !branchId) {
      setBranchId(branches[0].id);
    }
  }, [isBranchManager, branches, branchId]);

  const teamOptions = allTeams.filter((t) => !branchId || t.branch_id === branchId);
  return { branches, teams: teamOptions, branchId, setBranchId, teamId, setTeamId, isBranchManager };
}

function useCustomerBranches() {
  const [customerBranches, setCustomerBranches] = useState<{value: string; label: string}[]>([]);
  useEffect(() => {
    api.get("/customers/branches")
      .then((res) => setCustomerBranches(res.data.branches))
      .catch((err) => message.error(errorMessage(err)));
  }, []);
  return customerBranches;
}

/** Agents a TL can allocate to: active users who work customers. */
function useAssignableAgents(
  branchId: string | null,
  teamId: string | null,
) {
  const [agents, setAgents] = useState<Employee[]>([]);
  useEffect(() => {
    const params: Record<string, string> = { with_load: "true" };
    if (branchId) params.branch_id = branchId;
    if (teamId) params.team_id = teamId;
    api.get("/employees", { params }).then((res) => {
      setAgents(
        (res.data.employees as Employee[]).filter(
          (e) =>
            e.is_active &&
            e.capabilities.some((c) =>
              ["telecaller", "field_agent", "branch_manager"].includes(c),
            ),
        ),
      );
    }).catch((err) => message.error(errorMessage(err)));
  }, [branchId, teamId]);
  return agents;
}

function useCompanyFilters() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [buckets, setBuckets] = useState<string[]>([]);
  const [product, setProduct] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);

  useEffect(() => {
    api.get("/companies")
      .then((res) => setCompanies(res.data.companies))
      .catch((err) => message.error(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!companyId) {
      setProducts([]);
      setBuckets([]);
      setProduct(null);
      setBucket(null);
      return;
    }
    Promise.all([
      api.get("/products", { params: { company_id: companyId } }),
      api.get("/buckets", { params: { company_id: companyId } }),
    ]).then(([pRes, bRes]) => {
      setProducts(pRes.data.products);
      setBuckets(bRes.data.buckets.map((b: { label: string }) => b.label));
    }).catch((err) => message.error(errorMessage(err)));
  }, [companyId]);

  return { companies, companyId, setCompanyId, products, buckets, product, setProduct, bucket, setBucket };
}

function FilterRow({
  filters,
  branchTeam,
  agentPickerLabel,
}: {
  filters: ReturnType<typeof useCompanyFilters>;
  branchTeam: ReturnType<typeof useBranchTeam>;
  agentPickerLabel?: string;
}) {
  return (
    <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
      <Col xs={24} sm={8}>
        <Select
          style={{ width: "100%" }}
          title="All companies" placeholder="All companies"
          allowClear
          value={filters.companyId}
          onChange={(v) => {
            filters.setCompanyId(v ?? null);
            filters.setProduct(null);
            filters.setBucket(null);
          }}
          options={filters.companies.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Col>
      <Col xs={12} sm={3}>
        <Select
          style={{ width: "100%" }}
          title={agentPickerLabel ? "Branch (agent filter)" : "All branches"} placeholder={agentPickerLabel ? "Branch (agent filter)" : "All branches"}
          allowClear
          value={branchTeam.branchId}
          onChange={(v) => { branchTeam.setBranchId(v ?? null); branchTeam.setTeamId(null); }}
          options={branchTeam.branches.map((b) => ({ value: b.id, label: b.name }))}
        />
      </Col>
      <Col xs={12} sm={3}>
        <Select
          style={{ width: "100%" }}
          title={agentPickerLabel ? "Team (agent filter)" : "All teams"} placeholder={agentPickerLabel ? "Team (agent filter)" : "All teams"}
          allowClear
          value={branchTeam.teamId}
          onChange={(v) => branchTeam.setTeamId(v ?? null)}
          options={branchTeam.teams.map((t) => ({ value: t.id, label: t.name }))}
        />
      </Col>
      <Col xs={12} sm={5}>
        <Select
          style={{ width: "100%" }}
          title="All products" placeholder="All products"
          allowClear
          value={filters.product}
          onChange={(v) => filters.setProduct(v ?? null)}
          disabled={!filters.companyId}
          options={filters.products.map((p) => ({
            value: p.raw_label,
            label: p.canonical_label || p.raw_label,
          }))}
        />
      </Col>
      <Col xs={12} sm={5}>
        <Select
          style={{ width: "100%" }}
          title="All buckets" placeholder="All buckets"
          allowClear
          value={filters.bucket}
          onChange={(v) => filters.setBucket(v ?? null)}
          disabled={!filters.companyId}
          options={filters.buckets.map((b) => ({ value: b, label: b }))}
        />
      </Col>
    </Row>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Unallocated queue: filter → multi-select → assign
// ──────────────────────────────────────────────────────────────────────────────

function UnallocatedQueue({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const filters = useCompanyFilters();
  const branchTeam = useBranchTeam();
  const customerBranches = useCustomerBranches();
  const [customerBranch, setCustomerBranch] = useState<string>("");
  const agents = useAssignableAgents(branchTeam.branchId, branchTeam.teamId);
  const allAgents = useAssignableAgents(null, null);
  const telecallers = useMemo(() => allAgents.filter((a) => a.capabilities.includes("telecaller")), [allAgents]);
  const fieldAgents = useMemo(() => agents.filter((a) => a.capabilities.includes("field_agent")), [agents]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  // A ref, not a load() dependency: bumping page size shouldn't change
  // load's identity (that would retrigger the filters-changed effect below
  // and wipe the in-progress selection just for a size change).
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Keyed by customer id, not by page -- a selection made on page 1 must
  // survive paging to page 2 to actually allow "select more than 50 at once"
  // (previously load() wiped this on every page turn, capping every batch
  // assign at whatever fit on a single page).
  const [selected, setSelected] = useState<string[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [fieldAgentId, setFieldAgentId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assigningField, setAssigningField] = useState(false);

  const loadSeq = useRef(0);
  const load = useCallback(
    async (pg = 1, ps = pageSizeRef.current) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      setLoadError(null);
      try {
        const params: Record<string, string | number> = { page: pg, limit: ps };
        if (filters.companyId) params.company_id = filters.companyId;
        if (filters.product) params.product = filters.product;
        if (filters.bucket) params.bucket = filters.bucket;
        if (customerBranch) params.customer_branch = customerBranch;
        const res = await api.get("/allocations/unallocated", { params });
        if (seq !== loadSeq.current) return;
        setCustomers(res.data.customers);
        setTotal(res.data.total);
        setPage(pg);
      } catch (err) {
        if (seq !== loadSeq.current) return;
        setLoadError(errorMessage(err));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [filters.companyId, filters.product, filters.bucket, customerBranch],
  );

  // Fires only when a filter actually changes (load's identity depends on
  // the filters, not on the page) -- the right time to drop a selection
  // that pointed at a now-different result set.
  useEffect(() => {
    setSelected([]);
    load(1);
  }, [load]);

  const assign = () => {
    if (!agentId) return message.error("Pick an agent first");
    const agentName = agents.find((a) => a.id === agentId)?.full_name;
    Modal.confirm({
      title: `Assign ${selected.length} customer(s) to ${agentName}?`,
      content: "This will move them out of the unallocated queue immediately.",
      okText: "Assign",
      onOk: async () => {
        setAssigning(true);
        try {
          const res = await api.post("/allocations/assign", {
            customer_ids: selected,
            agent_id: agentId,
          });
          message.success(`${res.data.assigned} customer(s) assigned to ${res.data.agent_name}`);
          load(page);
        } catch (err) {
          message.error(errorMessage(err));
        } finally {
          setAssigning(false);
        }
      },
    });
  };

  const assignField = () => {
    if (!fieldAgentId) return message.error("Pick a field agent first");
    const fieldAgentName = agents.find((a) => a.id === fieldAgentId)?.full_name;
    Modal.confirm({
      title: `Assign ${selected.length} customer(s) to field agent ${fieldAgentName}?`,
      content: "This will move them out of the unallocated queue immediately.",
      okText: "Assign",
      onOk: async () => {
        setAssigningField(true);
        try {
          const res = await api.post("/allocations/assign-field-agent", {
            customer_ids: selected,
            agent_id: fieldAgentId,
          });
          message.success(`${res.data.assigned} customer(s) assigned to field agent ${res.data.agent_name}`);
          load(page);
        } catch (err) {
          message.error(errorMessage(err));
        } finally {
          setAssigningField(false);
        }
      },
    });
  };

  return (
    <div>
      {/* The "(agent filter)" labels below already say what these narrow --
          they used to need a paragraph underneath defending that behaviour;
          the labels alone should read as intentional, not broken. */}
      <FilterRow filters={filters} branchTeam={branchTeam} agentPickerLabel="Narrows agent picker" />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={6}>
          <Select
            style={{ width: "100%" }}
            title="Search customer branch" placeholder="Search customer branch"
            allowClear
            showSearch
            value={customerBranch || null}
            onChange={(v) => setCustomerBranch(v ?? "")}
            options={customerBranches}
          />
        </Col>
      </Row>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          action={<Button size="small" onClick={() => load(page)}>Retry</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      {selected.length > 0 && (
        <>
          <Alert
            type="info"
            style={{ marginBottom: 12 }}
            message={
              <Space wrap>
                <span>
                  <b>{selected.length}</b> customer(s) selected — assign to:
                </span>
                <Select
                  style={{ width: 200 }}
                  title="Choose telecaller" placeholder="Choose telecaller"
                  showSearch
                  optionFilterProp="label"
                  value={agentId}
                  onChange={setAgentId}
                  options={telecallers.map((a) => ({ value: a.id, label: a.assigned_count != null ? `${a.full_name} (${a.assigned_count} accounts)` : a.full_name }))}
                />
                <Button
                  type="primary"
                  icon={<UserSwitchOutlined />}
                  loading={assigning}
                  disabled={!agentId}
                  onClick={assign}
                >
                  Assign Telecaller
                </Button>
              </Space>
            }
          />
          <Alert
            type="info"
            style={{ marginBottom: 12 }}
            message={
              <Space wrap>
                <span>Or assign to field agent:</span>
                <Select
                  style={{ width: 200 }}
                  title="Choose field agent" placeholder="Choose field agent"
                  showSearch
                  optionFilterProp="label"
                  value={fieldAgentId}
                  onChange={setFieldAgentId}
                  options={fieldAgents.map((a) => ({ value: a.id, label: a.assigned_count != null ? `${a.full_name} (${a.assigned_count} accounts)` : a.full_name }))}
                />
                <Button
                  type="primary"
                  icon={<UserSwitchOutlined />}
                  loading={assigningField}
                  disabled={!fieldAgentId}
                  onClick={assignField}
                >
                  Assign Field Agent
                </Button>
              </Space>
            }
          />
        </>
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={customers}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [50, 100, 200, 500],
          showTotal: (t) => `${t.toLocaleString()} unallocated`,
          onChange: (pg, ps) => { setPageSize(ps); load(pg, ps); },
        }}
        scroll={{ x: 1100 }}
        columns={getBaseColumns(onOpenDetail)}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Allocated list: see who has what, reallocate with reason, view history
// ──────────────────────────────────────────────────────────────────────────────

function AllocatedList({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const filters = useCompanyFilters();
  const branchTeam = useBranchTeam();
  const customerBranches = useCustomerBranches();
  const [customerBranch, setCustomerBranch] = useState<string>("");
  const agents = useAssignableAgents(null, null);
  const telecallers = useMemo(() => agents.filter((a) => a.capabilities.includes("telecaller")), [agents]);
  const fieldAgents = useMemo(() => agents.filter((a) => a.capabilities.includes("field_agent")), [agents]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  // Reallocate modal state -- driven by the actual customer objects being
  // reallocated (not just ids carried over from checkbox selection), so a
  // single-row "Reallocate" click can never silently reuse a stale/empty
  // selection and POST an empty customer_ids array.
  const [reallocTargets, setReallocTargets] = useState<Customer[]>([]);
  const [reallocMode, setReallocMode] = useState<"telecaller" | "field_agent">("telecaller");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [fieldAgentId, setFieldAgentId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // History modal state
  const [historyFor, setHistoryFor] = useState<Customer | null>(null);
  const [history, setHistory] = useState<AllocationLog[]>([]);

  const loadSeq = useRef(0);
  const load = useCallback(
    async (pg = 1, ps = pageSizeRef.current) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      setLoadError(null);
      try {
        const params: Record<string, string | number> = {
          page: pg,
          limit: ps,
          assigned: "true",
          status: "active",
        };
        if (filters.companyId) params.company_id = filters.companyId;
        if (filters.product) params.product = filters.product;
        if (filters.bucket) params.bucket = filters.bucket;
        if (customerBranch) params.customer_branch = customerBranch;
        if (branchTeam.teamId) params.team_id = branchTeam.teamId;
        const res = await api.get("/customers", { params });
        if (seq !== loadSeq.current) return;
        setCustomers(res.data.customers);
        setTotal(res.data.total);
        setPage(pg);
      } catch (err) {
        if (seq !== loadSeq.current) return;
        setLoadError(errorMessage(err));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [filters.companyId, filters.product, filters.bucket, customerBranch, branchTeam.teamId],
  );

  // Only a filter change should drop the selection -- a plain page turn
  // must not (see UnallocatedQueue above for the same fix).
  useEffect(() => {
    setSelected([]);
    load(1);
  }, [load]);

  const openRealloc = (targets: Customer[]) => {
    setReallocTargets(targets);
    setReallocMode("telecaller");
    setAgentId(targets.length === 1 ? targets[0].assigned_agent_id : null);
    setFieldAgentId(targets.length === 1 ? targets[0].assigned_field_agent_id : null);
    setReason("");
  };

  const reallocate = async () => {
    const targetAgentId = reallocMode === "telecaller" ? agentId : fieldAgentId;
    if (!targetAgentId) {
      return message.error(`Pick the new ${reallocMode === "telecaller" ? "telecaller" : "field agent"}`);
    }
    if (!reason.trim()) return message.error("Reallocation needs a reason");
    setSaving(true);
    try {
      const endpoint = reallocMode === "telecaller" ? "/allocations/assign" : "/allocations/assign-field-agent";
      const res = await api.post(endpoint, {
        customer_ids: reallocTargets.map((c) => c.id),
        agent_id: targetAgentId,
        reason: reason.trim(),
      });
      message.success(`${res.data.assigned} customer(s) moved to ${res.data.agent_name}`);
      setReallocTargets([]);
      setReason("");
      setAgentId(null);
      setFieldAgentId(null);
      load(page);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async (customer: Customer) => {
    setHistoryFor(customer);
    setHistory([]);
    try {
      const res = await api.get("/allocations/logs", { params: { customer_id: customer.id } });
      setHistory(res.data.logs);
    } catch (err) {
      // Without this, a failed fetch left `history` at [], which the modal
      // renders identically to "no allocation history" -- a real error
      // masqueraded as an unremarkable empty state.
      message.error(errorMessage(err));
    }
  };

  const columns = useMemo(
    () => [
      ...getBaseColumns(onOpenDetail),
      {
        title: "Telecaller",
        dataIndex: "assigned_agent_name",
        width: 140,
        render: (v: string | null) => (v ? <Tag color="blue">{v}</Tag> : "—"),
      },
      {
        title: "Field Agent",
        dataIndex: "assigned_field_agent_name",
        width: 140,
        render: (v: string | null) => (v ? <Tag color="green">{v}</Tag> : "—"),
      },
      {
        title: "",
        key: "actions",
        width: 120,
        render: (_: unknown, record: Customer) => (
          <Space>
            <Button
              type="link"
              size="small"
              onClick={() => openRealloc([record])}
            >
              Reallocate
            </Button>
            <Button
              type="link"
              size="small"
              icon={<HistoryOutlined />}
              onClick={() => openHistory(record)}
            >
              History
            </Button>
          </Space>
        ),
      },
    ],
    [onOpenDetail, openHistory, openRealloc],
  );

  return (
    <div>
      <FilterRow filters={filters} branchTeam={branchTeam} />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={6}>
          <Select
            style={{ width: "100%" }}
            title="Search customer branch" placeholder="Search customer branch"
            allowClear
            showSearch
            value={customerBranch || null}
            onChange={(v) => setCustomerBranch(v ?? "")}
            options={customerBranches}
          />
        </Col>
      </Row>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          action={<Button size="small" onClick={() => load(page)}>Retry</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      {selected.length > 0 && (
        <Alert
          type="warning"
          style={{ marginBottom: 12 }}
          message={
            <Space wrap>
              <span>
                <b>{selected.length}</b> customer(s) selected
              </span>
              <Button
                type="primary"
                icon={<UserSwitchOutlined />}
                onClick={() => openRealloc(customers.filter((c) => selected.includes(c.id)))}
              >
                Reallocate…
              </Button>
            </Space>
          }
        />
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={customers}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [50, 100, 200, 500],
          showTotal: (t) => `${t.toLocaleString()} allocated`,
          onChange: (pg, ps) => { setPageSize(ps); load(pg, ps); },
        }}
        scroll={{ x: 1500 }}
        columns={columns}
      />

      <Modal
        open={reallocTargets.length > 0}
        title={
          reallocTargets.length === 1
            ? `Reallocate — ${reallocTargets[0].customer_name} (${reallocTargets[0].loan_number})`
            : `Reallocate ${reallocTargets.length} customer(s)`
        }
        onOk={reallocate}
        confirmLoading={saving}
        onCancel={() => setReallocTargets([])}
        okText="Reallocate"
        okButtonProps={{ disabled: !(reallocMode === "telecaller" ? agentId : fieldAgentId) || !reason.trim() }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {reallocTargets.length > 1 && (
            <div>
              <Typography.Text type="secondary">Customers</Typography.Text>
              <div style={{ maxHeight: 120, overflowY: "auto", marginTop: 4 }}>
                <Space size={[4, 4]} wrap>
                  {reallocTargets.map((c) => (
                    <Tag key={c.id}>
                      {c.customer_name} ({c.loan_number})
                    </Tag>
                  ))}
                </Space>
              </div>
            </div>
          )}
          <Segmented
            value={reallocMode}
            onChange={(v) => setReallocMode(v as "telecaller" | "field_agent")}
            options={[
              { label: "Telecaller", value: "telecaller" },
              { label: "Field Agent", value: "field_agent" },
            ]}
          />
          <div>
            <Typography.Text type="secondary">
              New {reallocMode === "telecaller" ? "telecaller" : "field agent"}
            </Typography.Text>
            <Select
              style={{ width: "100%", marginTop: 4 }}
              title="Choose agent" placeholder="Choose agent"
              showSearch
              optionFilterProp="label"
              value={reallocMode === "telecaller" ? agentId : fieldAgentId}
              onChange={reallocMode === "telecaller" ? setAgentId : setFieldAgentId}
              options={(reallocMode === "telecaller" ? telecallers : fieldAgents).map((a) => ({
                value: a.id,
                label: a.assigned_count != null ? `${a.full_name} (${a.assigned_count} accounts)` : a.full_name,
              }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary">
              Reason <Typography.Text type="danger">*</Typography.Text> (logged with timestamp)
            </Typography.Text>
            <Input.TextArea
              rows={2}
              style={{ marginTop: 4 }}
              placeholder="e.g. Agent on leave, field visit required…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </Space>
      </Modal>

      <Modal
        open={historyFor !== null}
        title={`Allocation history — ${historyFor?.customer_name ?? ""}`}
        footer={null}
        onCancel={() => setHistoryFor(null)}
      >
        {history.length === 0 ? (
          <Typography.Text type="secondary">No allocation history</Typography.Text>
        ) : (
          <Timeline
            style={{ marginTop: 16 }}
            items={history.map((log) => ({
              children: (
                <div>
                  <div>
                    <Tag color={log.slot === "field" ? "purple" : "default"}>
                      {log.slot === "field" ? "Field Agent" : "Telecaller"}
                    </Tag>
                    {log.from_agent_name ? (
                      <>
                        <Tag>{log.from_agent_name}</Tag>→<Tag color="blue">{log.to_agent_name}</Tag>
                      </>
                    ) : (
                      <>
                        First allocation to <Tag color="blue">{log.to_agent_name}</Tag>
                      </>
                    )}
                  </div>
                  {log.reason && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Reason: {log.reason}
                    </Typography.Text>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    by {log.allocated_by_name} · {new Date(log.created_at).toLocaleString("en-IN")}
                  </Typography.Text>
                </div>
              ),
            }))}
          />
        )}
      </Modal>
    </div>
  );
}

export default function AllocationPage() {
  const [detailDrawerId, setDetailDrawerId] = useState<string | null>(null);

  return (
    <div>
      <Typography.Title level={3} style={{ marginBottom: 24 }}>
        Customer Allocation
      </Typography.Title>
      <Tabs
        defaultActiveKey="unallocated"
        items={[
          { key: "unallocated", label: "Unallocated Queue", children: <UnallocatedQueue onOpenDetail={setDetailDrawerId} /> },
          { key: "allocated", label: "Allocated", children: <AllocatedList onOpenDetail={setDetailDrawerId} /> },
        ]}
      />
      <CustomerDetailDrawer
        customerId={detailDrawerId}
        open={detailDrawerId !== null}
        onClose={() => setDetailDrawerId(null)}
      />
    </div>
  );
}
