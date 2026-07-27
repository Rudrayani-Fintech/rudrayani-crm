import {
  Alert,
  Button,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { DownloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import CustomerDetailDrawer from "../components/CustomerDetailDrawer";
import { downloadCsv } from "../utils/csv";
import type { Company, Customer } from "../types";

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  active: { color: "green", label: "Active" },
  closed: { color: "default", label: "Closed" },
  recalled: { color: "orange", label: "Recalled" },
};

interface Product {
  id: string;
  raw_label: string;
  canonical_label: string;
}

// Everything below reads its initial value from the URL and writes back to
// it on change -- previously all of this was pure component state, so a
// refresh reset every filter, the back button left the page entirely
// instead of undoing the last filter change, and a customer drawer could
// never be linked to a colleague (no URL represented it at all).
export default function CustomersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [customerBranches, setCustomerBranches] = useState<{value: string; label: string}[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(() => searchParams.get("company_id"));
  const [customerBranch, setCustomerBranch] = useState<string | null>(() => searchParams.get("customer_branch"));
  const [products, setProducts] = useState<Product[]>([]);
  const [buckets, setBuckets] = useState<string[]>([]);
  const [product, setProduct] = useState<string | null>(() => searchParams.get("product"));
  const [bucket, setBucket] = useState<string | null>(() => searchParams.get("bucket"));
  const [status, setStatus] = useState<string | null>(() => searchParams.get("status"));
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(() => Number(searchParams.get("page")) || 1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(() => searchParams.get("customer"));

  // Mirrors every filter + the open drawer into the URL (replacing, not
  // pushing, so tweaking three filters in a row doesn't require three
  // presses of Back to leave the page).
  useEffect(() => {
    const next = new URLSearchParams();
    if (companyId) next.set("company_id", companyId);
    if (customerBranch) next.set("customer_branch", customerBranch);
    if (product) next.set("product", product);
    if (bucket) next.set("bucket", bucket);
    if (status) next.set("status", status);
    if (query) next.set("q", query);
    if (page > 1) next.set("page", String(page));
    if (detailId) next.set("customer", detailId);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, customerBranch, product, bucket, status, query, page, detailId]);

  useEffect(() => {
    Promise.all([
      api.get("/companies"),
      api.get("/customers/branches"),
    ]).then(([cRes, bRes]) => {
      setCompanies(cRes.data.companies);
      setCustomerBranches(bRes.data.branches);
    }).catch((err) => message.error(errorMessage(err)));
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

  // Guards against a fast filter/page change resolving out of order: only
  // the response for the most recently issued load() is ever applied.
  const loadSeq = useRef(0);
  const load = useCallback(async (pg = 1) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const params: Record<string, string | number> = { page: pg, limit: 50 };
      if (companyId) params.company_id = companyId;
      if (customerBranch) params.customer_branch = customerBranch;
      if (product) params.product = product;
      if (bucket) params.bucket = bucket;
      if (status) params.status = status;
      if (query) params.q = query;
      const res = await api.get("/customers", { params });
      if (seq !== loadSeq.current) return;
      setCustomers(res.data.customers);
      setTotal(res.data.total);
      setPage(pg);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // A failed load must not look like an empty book -- distinct from
      // the "import data first" empty state rendered below.
      setLoadError(errorMessage(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [companyId, customerBranch, product, bucket, status, query]);

  useEffect(() => {
    load(1);
  }, [load]);

  const fmtAmount = (v: string | null) =>
    v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Customers
        </Typography.Title>
        <Space>
          <Typography.Text type="secondary">{total.toLocaleString()} records</Typography.Text>
          <Button
            icon={<DownloadOutlined />}
            disabled={customers.length === 0}
            onClick={() =>
              downloadCsv(
                `customers-page-${page}.csv`,
                ["Loan No", "Customer", "Company", "Branch", "Product", "Bucket", "Status", "Due Amount", "POS"],
                customers.map((c) => [
                  c.loan_number,
                  c.customer_name,
                  c.company_name,
                  c.branch_name ?? "",
                  c.product ?? "",
                  c.bucket ?? "",
                  c.status,
                  c.due_amount ?? "",
                  c.pos ?? "",
                ]),
              )
            }
          >
            Export page as CSV
          </Button>
        </Space>
      </div>

      {/* Filters */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={6}>
          <Select
            style={{ width: "100%" }}
            title="All companies" placeholder="All companies"
            allowClear
            value={companyId}
            onChange={(v) => { setCompanyId(v ?? null); setProduct(null); setBucket(null); }}
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Col>
        <Col xs={12} sm={4}>
          <Select
            style={{ width: "100%" }}
            title="Branch" placeholder="Branch"
            allowClear
            showSearch
            value={customerBranch}
            onChange={(v) => setCustomerBranch(v ?? null)}
            options={customerBranches}
          />
        </Col>
        <Col xs={12} sm={3}>
          <Select
            style={{ width: "100%" }}
            title="All products" placeholder="All products"
            allowClear
            value={product}
            onChange={(v) => setProduct(v ?? null)}
            disabled={!companyId}
            options={products.map((p) => ({
              value: p.raw_label,
              label: p.canonical_label || p.raw_label,
            }))}
          />
        </Col>
        <Col xs={12} sm={3}>
          <Select
            style={{ width: "100%" }}
            title="All buckets" placeholder="All buckets"
            allowClear
            value={bucket}
            onChange={(v) => setBucket(v ?? null)}
            disabled={!companyId}
            options={buckets.map((b) => ({ value: b, label: b }))}
          />
        </Col>
        <Col xs={12} sm={3}>
          <Select
            style={{ width: "100%" }}
            title="All statuses" placeholder="All statuses"
            allowClear
            value={status}
            onChange={(v) => setStatus(v ?? null)}
            options={[
              { value: "active", label: "Active" },
              { value: "recalled", label: "Recalled" },
              { value: "closed", label: "Closed" },
            ]}
          />
        </Col>
        <Col xs={24} sm={5}>
          <Input.Search
            placeholder="Loan no / name / mobile"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onSearch={(v) => { setQuery(v); load(1); }}
            onKeyDown={(e) => { if (e.key === "Enter") { setQuery(search); load(1); } }}
            enterButton={<SearchOutlined />}
            allowClear
            onClear={() => { setSearch(""); setQuery(""); }}
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

      <Table
        rowKey="id"
        loading={loading}
        dataSource={customers}
        locale={{ emptyText: <Empty description="No customers found — import data first" /> }}
        onRow={(record) => ({
          onClick: () => setDetailId(record.id),
          style: { cursor: "pointer" },
        })}
        pagination={{
          current: page,
          pageSize: 50,
          total,
          showSizeChanger: false,
          showTotal: (t) => `${t.toLocaleString()} customers`,
          onChange: (pg) => load(pg),
        }}
        scroll={{ x: 1500 }}
        columns={[
          {
            title: "Status",
            dataIndex: "status",
            width: 90,
            render: (v: string) => <Tag color={STATUS_TAG[v]?.color ?? "default"}>{STATUS_TAG[v]?.label ?? v}</Tag>,
          },
          {
            title: "Loan No",
            dataIndex: "loan_number",
            width: 130,
            render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
          },
          { title: "Customer", dataIndex: "customer_name", ellipsis: true, width: 200 },
          { title: "Mobile", dataIndex: "mobile_number", width: 130, render: (v) => v ?? "—" },
          { title: "Company", dataIndex: "company_name", width: 150, ellipsis: true },
          { title: "Branch", dataIndex: "branch_name", width: 120, render: (v) => v ?? "—" },
          {
            title: "Product",
            dataIndex: "product",
            width: 120,
            render: (v) => (v ? <Tag>{v}</Tag> : "—"),
          },
          {
            title: "Bucket",
            dataIndex: "bucket",
            width: 80,
            render: (v) => (v ? <Tag color="orange">{v}</Tag> : "—"),
          },
          {
            title: "Due Amount",
            dataIndex: "due_amount",
            width: 130,
            align: "right",
            render: (v) => (
              <span className="money">{fmtAmount(v)}</span>
            ),
          },
          {
            title: "POS",
            dataIndex: "pos",
            width: 130,
            align: "right",
            render: (v) => (
              <span className="money">{fmtAmount(v)}</span>
            ),
          },
          {
            title: "EMI",
            dataIndex: "emi",
            width: 110,
            align: "right",
            render: (v) => <span className="money">{fmtAmount(v)}</span>,
          },
          {
            title: "Custom",
            key: "custom",
            width: 80,
            render: (_, r) => {
              const n = Object.keys(r.custom_fields ?? {}).length;
              // Not clickable on its own — the whole row opens the drawer,
              // which already shows these under "Customer Detail".
              return n ? <Tag>{n} field{n > 1 ? "s" : ""}</Tag> : null;
            },
          },
        ]}
      />

      <CustomerDetailDrawer
        customerId={detailId}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}
