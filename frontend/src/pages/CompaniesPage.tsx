import { Alert, Button, Empty, Form, Input, Modal, Table, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { Company } from "../types";

// Companies are the finance-company data sources (Hero, Bajaj, TVS, ...) —
// they own imported customers, they are not part of the agency org chart.
export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Company | "new" | null>(null);
  const [form] = Form.useForm<{ name: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setCompanies((await api.get("/companies")).data.companies);
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
        await api.post("/companies", values);
        message.success("Company added");
      } else if (editing) {
        await api.patch(`/companies/${editing.id}`, values);
        message.success("Company renamed");
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
          Companies
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Add company
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
        dataSource={companies}
        pagination={false}
        locale={{
          emptyText: (
            <Empty description="No companies yet — every import and customer belongs to one">
              <Button type="primary" onClick={openCreate}>
                Add your first company
              </Button>
            </Empty>
          ),
        }}
        columns={[
          { title: "Name", dataIndex: "name" },
          {
            title: "",
            width: 100,
            render: (_, record) => (
              <Button
                type="link"
                onClick={() => {
                  form.setFieldsValue({ name: record.name });
                  setEditing(record);
                }}
              >
                Rename
              </Button>
            ),
          },
        ]}
      />
      <Modal
        open={editing !== null}
        title={editing === "new" ? "Add company" : "Rename company"}
        onOk={save}
        onCancel={() => setEditing(null)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Company name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Hero FinCorp" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
