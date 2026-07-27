import { Alert, Button, Empty, Form, Input, Modal, Select, Table, Typography, message, Space } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import type { Branch, Team } from "../types";

// Phase 2: teams are a pure branch-scoped grouping -- every team in a
// branch reports directly to that branch's branch_manager, no per-team
// leader concept (not even a cosmetic label).
export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const [form] = Form.useForm<{ name: string; branch_id: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [teamsRes, branchesRes] = await Promise.all([
        api.get("/teams"),
        api.get("/branches"),
      ]);
      setTeams(teamsRes.data.teams);
      setBranches(branchesRes.data.branches);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing === "new") {
        await api.post("/teams", values);
        message.success("Team created");
      } else if (editing) {
        await api.patch(`/teams/${editing.id}`, values);
        message.success("Team updated");
      }
      setEditing(null);
      form.resetFields();
      load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const openCreate = () => {
    form.resetFields();
    setEditing("new");
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Teams
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={branches.length === 0}>
          Add team
        </Button>
      </div>

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
        dataSource={teams}
        pagination={false}
        locale={{
          emptyText:
            branches.length === 0 ? (
              <Empty description="No branches yet — a team needs one to belong to">
                <Link to="/branches">
                  <Button type="primary">Add a branch first</Button>
                </Link>
              </Empty>
            ) : (
              <Empty description="No teams yet">
                <Button type="primary" onClick={openCreate}>
                  Add your first team
                </Button>
              </Empty>
            ),
        }}
        columns={[
          { title: "Team", dataIndex: "name" },
          { title: "Branch", dataIndex: "branch_name" },
          {
            title: "",
            width: 100,
            render: (_, record) => (
              <Space>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    form.setFieldsValue({ name: record.name, branch_id: record.branch_id });
                    setEditing(record);
                  }}
                >
                  Edit
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={editing !== null}
        title={editing === "new" ? "Add team" : "Edit team"}
        onOk={save}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Team name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Team A" />
          </Form.Item>
          <Form.Item name="branch_id" label="Branch" rules={[{ required: true }]}>
            <Select
              options={branches.map((b) => ({ value: b.id, label: b.name }))}
              placeholder="Select branch"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
