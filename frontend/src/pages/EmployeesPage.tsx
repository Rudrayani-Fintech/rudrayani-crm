import {
  Alert,
  Button,
  Empty,
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
import { KeyOutlined, PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  CAPABILITY_LABELS,
  type AgentType,
  type Branch,
  type Designation,
  type Employee,
  type Team,
} from "../types";

interface EmployeeFormValues {
  full_name: string;
  phone: string;
  email?: string;
  password?: string;
  branch_id?: string | null;
  branch_ids?: string[]; // Multi-branch for telecaller-type work
  team_id?: string | null;
  team_ids?: string[]; // Multi-team for telecaller-type work
  manager_id?: string | null;
  managed_branch_id?: string | null;
  designation?: Exclude<Designation, "agency_admin">;
  agent_type?: AgentType | null;
  is_active?: boolean;
}

export default function EmployeesPage() {
  const { hasPermission } = useAuth();
  const canEditOps = hasPermission("ops_managers.create");

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [products, setProducts] = useState<{ raw_label: string; canonical_label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filterBranch, setFilterBranch] = useState<string | undefined>();
  const [filterTeam, setFilterTeam] = useState<string | undefined>();
  const [filterCapability, setFilterCapability] = useState<string | undefined>();
  // Default to Active so newly-deactivated/legacy inactive employees don't
  // clutter the default view -- switch to "Deactivated" via the filter to see them.
  const [filterStatus, setFilterStatus] = useState<"active" | "inactive" | undefined>("active");
  const [filterDesignation, setFilterDesignation] = useState<string | undefined>();
  const [filterCustomerBranch, setFilterCustomerBranch] = useState<string | undefined>();
  const [filterProduct, setFilterProduct] = useState<string | undefined>();
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [resettingFor, setResettingFor] = useState<Employee | null>(null);
  const [form] = Form.useForm<EmployeeFormValues>();
  const [resetForm] = Form.useForm<{ new_password: string }>();

  const selectedBranch = Form.useWatch("branch_id", form);
  const selectedDesignation = Form.useWatch("designation", form);
  const selectedAgentType = Form.useWatch("agent_type", form);
  const isManagerDesignation = selectedDesignation === "branch_manager";
  // A branch_manager ALSO carrying collections work behaves the same as a
  // plain telecaller/field_agent for location-assignment purposes.
  const isTelecallerType =
    selectedDesignation === "telecaller" || (isManagerDesignation && selectedAgentType === "telecaller");
  const isFieldAgentType =
    selectedDesignation === "field_agent" || (isManagerDesignation && selectedAgentType === "field_agent");
  const teamOptions = useMemo(
    () =>
      teams
        .filter((t) => !selectedBranch || t.branch_id === selectedBranch)
        .map((t) => ({ value: t.id, label: `${t.name} (${t.branch_name ?? ""})` })),
    [teams, selectedBranch],
  );

  // "Reports to" candidates: plausible managers only -- same branch or team
  // as the employee being edited, active, and never the employee themself.
  // manager_id has no permission meaning (informational only), so this is
  // just a sane default list, not a hard server-side restriction.
  const managerOptions = useMemo(() => {
    const selfId = editing && editing !== "new" ? editing.id : undefined;
    const activeEmployees = employees.filter((e) => e.is_active && e.id !== selfId);

    if (selectedDesignation === "operations_manager") {
      return activeEmployees
        .filter((e) => e.capabilities.includes("agency_admin"))
        .map((e) => ({ value: e.id, label: e.full_name }));
    }

    if (selectedDesignation === "branch_manager") {
      return activeEmployees
        .filter((e) => e.capabilities.includes("operations_manager"))
        .map((e) => ({ value: e.id, label: e.full_name }));
    }

    if (selectedDesignation === "telecaller" || selectedDesignation === "field_agent") {
      return activeEmployees
        .filter((e) => e.capabilities.includes("branch_manager"))
        .map((e) => ({ value: e.id, label: e.full_name }));
    }

    return [];
  }, [employees, editing, selectedDesignation]);

  useEffect(() => {
    if (selectedDesignation === "operations_manager") {
      const selfId = editing && editing !== "new" ? editing.id : undefined;
      const admins = employees.filter(
        (e) => e.is_active && e.id !== selfId && e.capabilities.includes("agency_admin")
      );
      if (admins.length === 1) {
        const currentManager = form.getFieldValue("manager_id");
        if (!currentManager || !admins.find((a) => a.id === currentManager)) {
          form.setFieldValue("manager_id", admins[0].id);
        }
      }
    }
  }, [selectedDesignation, employees, form, editing]);

  // No client-side filtering - all filtering now done server-side via query params
  const filteredEmployees = employees;

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const params: Record<string, string> = {};
      if (search) params.q = search;
      if (filterBranch) params.branch_id = filterBranch;
      if (filterTeam) params.team_id = filterTeam;
      if (filterStatus === "active") params.is_active = "true";
      if (filterStatus === "inactive") params.is_active = "false";
      if (filterDesignation) params.designation = filterDesignation;
      if (filterCustomerBranch) params.customer_branch = filterCustomerBranch;
      if (filterProduct) params.product = filterProduct;

      const [emp, br, tm, prod] = await Promise.all([
        api.get("/employees", { params }),
        api.get("/branches"),
        api.get("/teams"),
        api.get("/products"),
      ]);
      if (seq !== loadSeq.current) return;
      setEmployees(emp.data.employees);
      setBranches(br.data.branches);
      setTeams(tm.data.teams);
      setProducts(prod.data.products);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(errorMessage(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [search, filterBranch, filterTeam, filterStatus, filterDesignation, filterCustomerBranch, filterProduct]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce the search box -- `search` is a dependency of `load` (a
  // useCallback), so updating it directly on every keystroke fired a network
  // request per character. `searchInput` tracks what's actually typed;
  // `search` (and therefore the request) only follows 300ms after typing
  // stops, or immediately on Enter/onSearch below (which also cancels this
  // pending timer so it can't clobber the immediate value moments later).
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    searchDebounceRef.current = setTimeout(() => setSearch(searchInput), 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchInput]);

  const branchName = (id: string | null) => branches.find((b) => b.id === id)?.name ?? "—";
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "—";

  // Telecaller-type employees (plain telecallers, or branch_manager with
  // agent_type=telecaller) carry their real assignment in branch_ids/team_ids
  // (multi-branch, multi-team) -- their scalar branch_id/team_id is always null,
  // so falling back to those columns would wrongly show "—" for them.
  const branchCell = (e: Employee) =>
    e.branch_ids && e.branch_ids.length > 0 ? (
      <Space size={[0, 4]} wrap>
        {e.branch_ids.map((id) => (
          <Tag key={id}>{branchName(id)}</Tag>
        ))}
      </Space>
    ) : e.designation === "branch_manager" ? (
      branchName(e.managed_branch_id ?? null)
    ) : (
      branchName(e.branch_id)
    );
  const teamCell = (e: Employee) =>
    e.team_ids && e.team_ids.length > 0 ? (
      <Space size={[0, 4]} wrap>
        {e.team_ids.map((id) => (
          <Tag key={id}>{teamName(id)}</Tag>
        ))}
      </Space>
    ) : (
      teamName(e.team_id)
    );

  const openCreate = () => {
    form.resetFields();
    setEditing("new");
  };

  const openEdit = (e: Employee) => {
    const isTelecallerTypeRow = e.designation === "telecaller" || e.agent_type === "telecaller";
    const isFieldAgentTypeRow = e.designation === "field_agent" || e.agent_type === "field_agent";
    form.setFieldsValue({
      full_name: e.full_name,
      phone: e.phone,
      email: e.email ?? undefined,
      branch_id: isFieldAgentTypeRow || !isTelecallerTypeRow ? e.branch_id : undefined,
      branch_ids: isTelecallerTypeRow ? (e.branch_ids ?? (e.branch_id ? [e.branch_id] : [])) : undefined,
      team_id: isFieldAgentTypeRow || !isTelecallerTypeRow ? e.team_id : undefined,
      team_ids: isTelecallerTypeRow ? (e.team_ids ?? (e.team_id ? [e.team_id] : [])) : undefined,
      manager_id: e.manager_id,
      managed_branch_id: e.managed_branch_id ?? undefined,
      designation: e.designation as EmployeeFormValues["designation"],
      agent_type: e.agent_type ?? undefined,
      is_active: e.is_active,
    });
    setEditing(e);
  };

  const save = async () => {
    const v = await form.validateFields();
    const managerDesignation = v.designation === "branch_manager";
    const telecallerType = v.designation === "telecaller" || (managerDesignation && v.agent_type === "telecaller");
    const agentType = managerDesignation ? (v.agent_type ?? null) : undefined;

    try {
      if (editing === "new") {
        const created = await api.post("/employees", {
          full_name: v.full_name,
          phone: v.phone,
          email: v.email || null,
          password: v.password,
          branch_id: telecallerType ? null : (v.branch_id ?? null),
          team_id: telecallerType ? null : (v.team_id ?? null),
          manager_id: v.manager_id ?? null,
          managed_branch_id: managerDesignation ? (v.managed_branch_id ?? null) : undefined,
          designation: v.designation,
          agent_type: agentType,
        });
        message.success("Employee created");

        if (telecallerType) {
          const newId = created.data.employee.id;
          await api.put(`/employees/${newId}/branches`, { branch_ids: v.branch_ids ?? [] });
          await api.put(`/employees/${newId}/teams`, { team_ids: v.team_ids ?? [] });
        }
      } else if (editing) {
        await api.patch(`/employees/${editing.id}`, {
          full_name: v.full_name,
          email: v.email || null,
          branch_id: telecallerType ? null : (v.branch_id ?? null),
          team_id: telecallerType ? null : (v.team_id ?? null),
          manager_id: v.manager_id ?? null,
          managed_branch_id: managerDesignation ? (v.managed_branch_id ?? null) : undefined,
          is_active: v.is_active,
          designation: v.designation,
          agent_type: agentType,
        });
        message.success("Employee updated");

        // Multi-branch/multi-team assignment for telecaller-type work
        // (plain telecallers, or branch_manager with agent_type
        // = telecaller) -- their work is remote calling, not tied to one
        // place, so it's tracked in junction tables, not the form's scalar
        // branch_id/team_id.
        if (telecallerType) {
          await api.put(`/employees/${editing.id}/branches`, { branch_ids: v.branch_ids ?? [] });
          await api.put(`/employees/${editing.id}/teams`, { team_ids: v.team_ids ?? [] });
        }
      }
      setEditing(null);
      form.resetFields();
      load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const resetPassword = async () => {
    const v = await resetForm.validateFields();
    try {
      await api.post(`/employees/${resettingFor!.id}/reset-password`, v);
      message.success("Password reset — their existing sessions were logged out");
      setResettingFor(null);
      resetForm.resetFields();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const isAdminRow = (e: Employee) => e.capabilities.includes("agency_admin");

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Employees
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search name or phone"
            allowClear
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onSearch={(v) => {
              if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
              setSearch(v);
            }}
            style={{ width: 260 }}
          />
          {hasPermission("employees.create") && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Add employee
            </Button>
          )}
        </Space>
      </div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 160 }}
          title="All branches" placeholder="All branches"
          allowClear
          value={filterBranch}
          onChange={(v) => { setFilterBranch(v ?? undefined); setFilterTeam(undefined); }}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Select
          style={{ width: 160 }}
          title="All teams" placeholder="All teams"
          allowClear
          value={filterTeam}
          onChange={(v) => setFilterTeam(v ?? undefined)}
          options={teams
            .filter((t) => !filterBranch || t.branch_id === filterBranch)
            .map((t) => ({ value: t.id, label: t.name }))}
        />
        <Select
          style={{ width: 160 }}
          title="All designations" placeholder="All designations"
          allowClear
          value={filterDesignation}
          onChange={(v) => setFilterDesignation(v ?? undefined)}
          options={[
            { value: "operations_manager", label: "Ops Manager" },
            { value: "branch_manager", label: "Branch Manager" },
            { value: "telecaller", label: "Telecaller" },
            { value: "field_agent", label: "Field Agent" },
          ]}
        />
        <Select
          style={{ width: 160 }}
          title="All capabilities" placeholder="All capabilities"
          allowClear
          value={filterCapability}
          onChange={(v) => setFilterCapability(v ?? undefined)}
          options={[
            { value: "telecaller", label: "Telecaller" },
            { value: "field_agent", label: "Field Agent" },
            { value: "branch_manager", label: "Branch Manager" },
            { value: "operations_manager", label: "Ops Manager" },
          ]}
        />
        <Select
          style={{ width: 160 }}
          title="Customer branch" placeholder="Customer branch"
          allowClear
          value={filterCustomerBranch}
          onChange={(v) => setFilterCustomerBranch(v ?? undefined)}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Select
          style={{ width: 140 }}
          title="Product" placeholder="Product"
          allowClear
          value={filterProduct}
          onChange={(v) => setFilterProduct(v ?? undefined)}
          options={products.map((p) => ({
            value: p.raw_label,
            label: p.canonical_label || p.raw_label,
          }))}
        />
        <Select
          style={{ width: 140 }}
          title="All statuses" placeholder="All statuses"
          allowClear
          value={filterStatus}
          onChange={(v) => setFilterStatus(v ?? undefined)}
          options={[
            { value: "active", label: "Active" },
            { value: "inactive", label: "Deactivated" },
          ]}
        />
      </Space>

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
        dataSource={filteredEmployees}
        scroll={{ x: 900 }}
        locale={{
          emptyText:
            search || filterBranch || filterTeam || filterCapability || filterDesignation || filterCustomerBranch || filterProduct ? (
              <Empty description="No employees match your filters" />
            ) : (
              // The #1 day-1 task for a new agency previously landed on
              // AntD's bare "No Data" with zero guidance on what to do.
              <Empty description="No employees yet">
                {hasPermission("employees.create") && (
                  <Button type="primary" onClick={openCreate}>
                    Add your first employee
                  </Button>
                )}
              </Empty>
            ),
        }}
        columns={[
          { title: "Name", dataIndex: "full_name" },
          { title: "Phone", dataIndex: "phone" },
          { title: "Branch", render: (_, e) => branchCell(e) },
          { title: "Team", render: (_, e) => teamCell(e) },
          {
            title: "Reports To",
            dataIndex: "manager_name",
            render: (name: string | null) => name ?? <Typography.Text type="secondary">—</Typography.Text>,
          },
          {
            title: "Capabilities",
            dataIndex: "capabilities",
            render: (caps: Employee["capabilities"]) => (
              <>
                {caps.map((c) => (
                  <Tag color={c === "agency_admin" ? "gold" : "blue"} key={c}>
                    {CAPABILITY_LABELS[c]}
                  </Tag>
                ))}
              </>
            ),
          },
          {
            title: "Status",
            dataIndex: "is_active",
            render: (active: boolean) =>
              active ? <Tag color="green">Active</Tag> : <Tag color="red">Deactivated</Tag>,
          },
          {
            title: "",
            width: 160,
            render: (_, e) =>
              isAdminRow(e) ? (
                <Tooltip title="The Agency Admin account is managed outside this screen">
                  <Typography.Text type="secondary">—</Typography.Text>
                </Tooltip>
              ) : (
                <Space>
                  {hasPermission("employees.update") && (
                    <>
                      <Button type="link" style={{ padding: 0 }} onClick={() => openEdit(e)}>
                        Edit
                      </Button>
                      <Button
                        type="link"
                        style={{ padding: 0 }}
                        icon={<KeyOutlined />}
                        onClick={() => setResettingFor(e)}
                      >
                        Reset password
                      </Button>
                    </>
                  )}
                </Space>
              ),
          },
        ]}
      />

      <Modal
        open={editing !== null}
        title={editing === "new" ? "Add employee" : "Edit employee"}
        onOk={save}
        onCancel={() => setEditing(null)}
        destroyOnClose
        width={520}
      >
        <Form form={form} layout="vertical" scrollToFirstError={{ behavior: "smooth", block: "center" }}>
          <Form.Item name="full_name" label="Full name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="phone"
            label="Phone (login ID)"
            rules={[{ required: true, pattern: /^\d{10}$/, message: "Exactly 10 digits" }]}
          >
            <Input disabled={editing !== "new"} addonBefore="+91" maxLength={10} />
          </Form.Item>
          <Form.Item name="email" label="Email (optional)" rules={[{ type: "email" }]}>
            <Input />
          </Form.Item>
          {editing === "new" && (
            <Form.Item
              name="password"
              label="Initial password"
              rules={[{ required: true, min: 8, message: "At least 8 characters" }]}
            >
              <Input.Password />
            </Form.Item>
          )}
          <Form.Item name="designation" label="Designation" rules={[{ required: true }]}>
            <Select
              options={[
                canEditOps ? { value: "operations_manager", label: "Operations Manager" } : null,
                { value: "branch_manager", label: "Branch Manager" },
                { value: "telecaller", label: "Telecaller" },
                { value: "field_agent", label: "Field Agent" },
              ].filter((o): o is any => o !== null)}
              onChange={() => {
                form.setFieldValue("agent_type", undefined);
                form.setFieldValue("branch_id", undefined);
                form.setFieldValue("managed_branch_id", undefined);
                form.setFieldValue("team_id", undefined);
                form.setFieldValue("branch_ids", undefined);
                form.setFieldValue("team_ids", undefined);
              }}
            />
          </Form.Item>

          {isManagerDesignation && (
            <Form.Item name="agent_type" label="Also does collections work as">
              <Select
                allowClear
                title="No — management only" placeholder="No — management only"
                options={[
                  { value: "telecaller", label: "Telecaller-type (remote calling)" },
                  { value: "field_agent", label: "Field Agent-type (in-person visits)" },
                ]}
                onChange={() => {
                  form.setFieldValue("branch_id", undefined);
                  form.setFieldValue("team_id", undefined);
                  form.setFieldValue("branch_ids", undefined);
                  form.setFieldValue("team_ids", undefined);
                }}
              />
            </Form.Item>
          )}

          {selectedDesignation === "branch_manager" && (
            <Form.Item
              name="managed_branch_id"
              label="Managed Branch"
              rules={[{ required: true, message: "A Branch Manager must be assigned a branch to manage" }]}
            >
              <Select
                allowClear
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
                placeholder="Select managed branch"
              />
            </Form.Item>
          )}

          {isTelecallerType && (
            <>
              <Form.Item
                name="branch_ids"
                label="Branches (calling coverage)"
                rules={[{ required: true, message: "At least one branch required" }]}
              >
                <Select
                  mode="multiple"
                  allowClear
                  options={branches.map((b) => ({ value: b.id, label: b.name }))}
                  placeholder="Select one or more branches"
                />
              </Form.Item>
              <Form.Item
                name="team_ids"
                label="Teams (calling coverage)"
                rules={[{ required: true, message: "At least one team required" }]}
              >
                <Select
                  mode="multiple"
                  allowClear
                  options={teams.map((t) => ({ value: t.id, label: `${t.name} (${t.branch_name ?? ""})` }))}
                  placeholder="Select one or more teams"
                />
              </Form.Item>
            </>
          )}

          {isFieldAgentType && (
            <>
              <Form.Item name="branch_id" label="Branch">
                <Select
                  allowClear
                  options={branches.map((b) => ({ value: b.id, label: b.name }))}
                  onChange={() => form.setFieldValue("team_id", undefined)}
                />
              </Form.Item>
              <Form.Item name="team_id" label="Team">
                <Select allowClear options={teamOptions} />
              </Form.Item>
            </>
          )}

          {selectedDesignation === "operations_manager" && (
            <>
              <Form.Item name="branch_id" label="Branch">
                <Select
                  allowClear
                  options={branches.map((b) => ({ value: b.id, label: b.name }))}
                  onChange={() => form.setFieldValue("team_id", undefined)}
                />
              </Form.Item>
              <Form.Item name="team_id" label="Team">
                <Select allowClear options={teamOptions} />
              </Form.Item>
            </>
          )}

          <Form.Item
            name="manager_id"
            label="Reports to"
            rules={[
              ({ getFieldValue }) => ({
                required: getFieldValue("designation") && getFieldValue("designation") !== "agency_admin",
                message: "Manager required for non-admin designations",
              }),
            ]}
          >
            <Select
              allowClear
              showSearch
              title="No manager" placeholder="No manager"
              optionFilterProp="label"
              options={managerOptions}
            />
          </Form.Item>
          {editing !== "new" && hasPermission("employees.deactivate") && (
            <Form.Item name="is_active" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        open={resettingFor !== null}
        title={`Reset password — ${resettingFor?.full_name ?? ""}`}
        onOk={resetPassword}
        onCancel={() => setResettingFor(null)}
        destroyOnClose
      >
        <Form form={resetForm} layout="vertical">
          <Form.Item
            name="new_password"
            label="New password"
            rules={[{ required: true, min: 8, message: "At least 8 characters" }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
