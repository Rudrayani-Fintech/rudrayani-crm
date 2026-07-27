import { Alert, Button, Form, Input, Modal, Select, Space, Table, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import BranchDetailDrawer from "../components/BranchDetailDrawer";
import type { Branch, Employee } from "../types";

interface BranchFormValues {
  name: string;
  branch_manager_id?: string | null;
}

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchManagers, setBranchManagers] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Branch | "new" | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form] = Form.useForm<BranchFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [br, bm] = await Promise.all([
        api.get("/branches"),
        api.get("/employees", { params: { designation: "branch_manager" } }),
      ]);
      setBranches(br.data.branches);
      setBranchManagers(bm.data.employees);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Non-blocking prompts (Requirement B): surface the gaps that matter for
  // this hierarchy without blocking anyone from saving -- reuses the same
  // Ant Design Alert pattern already used elsewhere (AllocationPage etc.)
  // rather than inventing a new UI language.
  const unmanagedBranches = useMemo(() => branches.filter((b) => !b.branch_manager_id), [branches]);
  const unassignedManagers = useMemo(
    () => branchManagers.filter((bm) => !branches.some((b) => b.branch_manager_id === bm.id)),
    [branchManagers, branches],
  );

  const editingId = editing !== "new" && editing ? editing.id : undefined;
  const availableManagerOptions = useMemo(
    () =>
      branchManagers
        .filter((bm) => !branches.some((b) => b.branch_manager_id === bm.id && b.id !== editingId))
        .map((bm) => ({ value: bm.id, label: bm.full_name })),
    [branchManagers, branches, editingId],
  );

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing === "new") {
        await api.post("/branches", values);
        message.success("Branch created");
      } else if (editing) {
        await api.patch(`/branches/${editing.id}`, values);
        message.success("Branch updated");
      }
      setEditing(null);
      form.resetFields();
      load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Branches
        </Typography.Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setEditing("new");
          }}
        >
          Add branch
        </Button>
      </div>

      {(unmanagedBranches.length > 0 || unassignedManagers.length > 0) && (
        <Space direction="vertical" style={{ width: "100%", marginBottom: 16 }}>
          {unmanagedBranches.length > 0 && (
            <Alert
              type="warning"
              showIcon
              closable
              message={`${unmanagedBranches.length} branch${unmanagedBranches.length > 1 ? "es have" : " has"} no manager assigned yet`}
              description={unmanagedBranches.map((b) => b.name).join(", ")}
            />
          )}
          {unassignedManagers.length > 0 && (
            <Alert
              type="info"
              showIcon
              closable
              message={`${unassignedManagers.length} branch manager${unassignedManagers.length > 1 ? "s are" : " is"} not linked to any branch`}
              description={unassignedManagers.map((bm) => bm.full_name).join(", ")}
            />
          )}
        </Space>
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
        dataSource={branches}
        pagination={false}
        scroll={{ x: 500 }}
        onRow={(record) => ({
          onClick: () => setDetailId(record.id),
          style: { cursor: "pointer" },
        })}
        columns={[
          { title: "Name", dataIndex: "name" },
          {
            title: "Branch Manager",
            dataIndex: "branch_manager_name",
            render: (name: string | null) =>
              name ?? <Typography.Text type="secondary">Not assigned</Typography.Text>,
          },
          {
            title: "",
            width: 100,
            render: (_, record) => (
              <Button
                type="link"
                onClick={(e) => {
                  e.stopPropagation();
                  form.setFieldsValue({ name: record.name, branch_manager_id: record.branch_manager_id ?? undefined });
                  setEditing(record);
                }}
              >
                Edit
              </Button>
            ),
          },
        ]}
      />
      <BranchDetailDrawer
        branchId={detailId}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
      />
      <Modal
        open={editing !== null}
        title={editing === "new" ? "Add branch" : "Edit branch"}
        onOk={save}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Branch name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Sangli" />
          </Form.Item>
          <Form.Item name="branch_manager_id" label="Branch Manager (optional)">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              title="Assign later" placeholder="Assign later"
              options={availableManagerOptions}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
