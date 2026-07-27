import { Alert, Button, InputNumber, Modal, Radio, Select, Space, Table, Tag, Typography, message } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";

type Bucket = {
  id: string;
  label: string;
  sort_order: number;
  category: "normal" | "npa";
  is_current: boolean;
  canonical_bucket: number | null;
};

type Company = { id: string; name: string };

/**
 * Buckets master (Phase 5 dashboard): order buckets by delinquency progression
 * and flag which are NPA (Recovery metric) and which means "current"
 * (Normalization metric). Labels arrive automatically from imports.
 */
export default function BucketsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get("/companies").then((res) => setCompanies(res.data.companies)).catch((err) => message.error(errorMessage(err)));
  }, []);

  const load = useCallback(async () => {
    if (!companyId) {
      setBuckets([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get("/buckets", { params: { company_id: companyId } });
      setBuckets(res.data.buckets);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Without this, clicking up/down twice quickly fires two overlapping PUTs
  // against the same optimistic array -- whichever response lands last wins,
  // silently discarding the other click's reorder.
  const [reordering, setReordering] = useState(false);
  const move = async (index: number, delta: -1 | 1) => {
    const next = [...buckets];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setBuckets(next); // optimistic
    setReordering(true);
    try {
      await api.put("/buckets/reorder", {
        company_id: companyId,
        ordered_ids: next.map((b) => b.id),
      });
    } catch (err) {
      message.error(errorMessage(err));
      void load();
    } finally {
      setReordering(false);
    }
  };

  const patch = async (
    id: string,
    body: Partial<Pick<Bucket, "category" | "is_current" | "canonical_bucket">>,
  ) => {
    try {
      await api.patch(`/buckets/${id}`, body);
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  // Flipping a bucket to NPA changes how Recovery/Rollback are computed on
  // the performance dashboard for every account currently sitting in it --
  // worth a confirmation. Reversing back to normal is a corrective action
  // and stays a plain click.
  const setCategory = (b: Bucket, category: Bucket["category"]) => {
    if (category !== "npa" || b.category === "npa") return void patch(b.id, { category });
    Modal.confirm({
      title: `Flag "${b.label}" as NPA?`,
      content:
        "This changes how Recovery and Rollback are computed on the performance dashboard for every account currently in this bucket.",
      okText: "Flag as NPA",
      okButtonProps: { danger: true },
      onOk: () => patch(b.id, { category }),
    });
  };

  const hasCurrent = buckets.some((b) => b.is_current);

  return (
    <div>
      <Typography.Title level={4}>Buckets</Typography.Title>
      <Typography.Paragraph type="secondary">
        Order buckets from least to most overdue. Mark the bucket that means the account is
        fully regular as <Tag>Current</Tag> and flag NPA buckets — the performance dashboard
        uses these to compute Normalization, Rollback and Recovery. Map each label to a{" "}
        <b>canonical bucket</b> (0 = X / current month, 1 = 30 DPD, 2 = 60 DPD, …) once, so
        in-house payment activity can be compared to a standard delinquency scale across
        companies whose own labels differ.
      </Typography.Paragraph>

      <Space style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 280 }}
          title="Select company" placeholder="Select company"
          value={companyId}
          onChange={setCompanyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Space>

      {companyId && !hasCurrent && buckets.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="No bucket is marked as Current — the Normalization metric cannot be computed for this company until one is."
        />
      )}

      <Table<Bucket>
        rowKey="id"
        loading={loading}
        dataSource={buckets}
        pagination={false}
        columns={[
          {
            title: "Order",
            width: 110,
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
                  disabled={index === buckets.length - 1 || reordering}
                  onClick={() => void move(index, 1)}
                />
              </Space>
            ),
          },
          { title: "Bucket", dataIndex: "label" },
          {
            title: "Category",
            width: 220,
            render: (_, b) => (
              <Radio.Group
                size="small"
                value={b.category}
                onChange={(e) => setCategory(b, e.target.value)}
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "npa", label: "NPA" },
                ]}
                optionType="button"
              />
            ),
          },
          {
            title: "Current bucket",
            width: 160,
            render: (_, b) =>
              b.is_current ? (
                <Tag color="green">Current</Tag>
              ) : (
                <Button size="small" type="link" onClick={() => void patch(b.id, { is_current: true })}>
                  Mark current
                </Button>
              ),
          },
          {
            title: "Canonical (DPD bucket)",
            width: 200,
            render: (_, b) => (
              <Space>
                <InputNumber
                  size="small"
                  min={0}
                  max={20}
                  style={{ width: 70 }}
                  value={b.canonical_bucket}
                  placeholder="—"
                  onChange={(v) => void patch(b.id, { canonical_bucket: v })}
                />
                {b.canonical_bucket === null && <Tag color="warning">Unmapped</Tag>}
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
