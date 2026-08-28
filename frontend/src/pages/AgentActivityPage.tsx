import { Button, message, Row, Col, Spin, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import CustomerDetailDrawer from "../components/CustomerDetailDrawer";
import FilterBar from "../components/agent-activity/FilterBar";
import ActivityTable from "../components/agent-activity/ActivityTable";
import type { AgentActivityResponse, AgentActivityRow, FilterState, LookupOptions } from "../components/agent-activity/types";

export default function AgentActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<LookupOptions>({
    branches: [],
    buckets: [],
    agents: [],
    companies: [],
    products: [],
    dispositionCodes: [],
  });
  const [activity, setActivity] = useState<AgentActivityRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [filters, setFilters] = useState<FilterState>(() => {
    const date = searchParams.get("date") || dayjs().format("YYYY-MM-DD");
    const search = searchParams.get("search") || "";
    const branchIds = searchParams.getAll("branch_id");
    const buckets = searchParams.getAll("bucket");
    const agentIds = searchParams.getAll("agent_id");
    const agentType = (searchParams.get("agent_type") as FilterState["agentType"]) || "all";
    const companyIds = searchParams.getAll("company_id");
    const products = searchParams.getAll("product");
    const actionTypes = (searchParams.getAll("action_type") as any[]) || ["call", "payment", "ptp", "field_visit"];
    const dispositionCodeIds = searchParams.getAll("disposition_code_id");
    const ptpStatuses = (searchParams.getAll("ptp_status") as any[]) || [];

    return { date, search, branchIds, buckets, agentIds, agentType, companyIds, products, actionTypes, dispositionCodeIds, ptpStatuses };
  });
  const [page, setPage] = useState(parseInt(searchParams.get("page") || "1"));
  const pageSize = 50;

  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  // Load lookup options
  useEffect(() => {
    const loadOptions = async () => {
      try {
        const [branchesRes, agentsRes, companiesRes, dispositionCodesRes] = await Promise.all([
          api.get("/branches"),
          api.get("/employees"),
          api.get("/companies"),
          api.get("/disposition-codes"),
        ]);

        const branches = branchesRes.data.branches || [];
        const agents = (agentsRes.data.employees || [])
          .filter((e: any) => e.is_active && (e.capabilities.includes("telecaller") || e.capabilities.includes("field_agent")))
          .map((e: any) => ({ id: e.id, full_name: e.full_name }));
        const companies = companiesRes.data.companies || [];
        const dispositionCodes = dispositionCodesRes.data.dispositionCodes || [];
        const buckets: string[] = [];
        const products: string[] = [];

        setOptions({ branches, agents, buckets, companies, products, dispositionCodes });
      } catch (err) {
        message.error(errorMessage(err));
      }
    };

    loadOptions();
  }, []);

  // Fetch activity data
  useEffect(() => {
    const fetchActivity = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          date: filters.date,
          page: page.toString(),
          limit: pageSize.toString(),
        });

        if (filters.search) params.append("search", filters.search);
        filters.branchIds.forEach((id) => params.append("branch_id", id));
        filters.buckets.forEach((b) => params.append("bucket", b));
        filters.agentIds.forEach((id) => params.append("agent_id", id));
        if (filters.agentType !== "all") params.append("agent_type", filters.agentType);
        filters.companyIds.forEach((id) => params.append("company_id", id));
        filters.products.forEach((p) => params.append("product", p));
        filters.actionTypes.forEach((a) => params.append("action_type", a));
        filters.dispositionCodeIds.forEach((id) => params.append("disposition_code_id", id));
        filters.ptpStatuses.forEach((s) => params.append("ptp_status", s));

        const response = await api.get<AgentActivityResponse>("/reports/agent-activity", {
          params,
        });

        setActivity(response.data.activity || []);
        setTotalCount(response.data.total_count || 0);

        // Sync URL params
        const newParams = new URLSearchParams(params);
        setSearchParams(newParams);
      } catch (err) {
        message.error(errorMessage(err));
        setActivity([]);
        setTotalCount(0);
      } finally {
        setLoading(false);
      }
    };

    fetchActivity();
  }, [filters, page, setSearchParams]);

  const handleFilterChange = (newFilters: FilterState) => {
    setFilters(newFilters);
    setPage(1); // Reset to page 1 when filters change
  };

  const handleExport = async () => {
    try {
      const params = new URLSearchParams({
        date: filters.date,
      });

      if (filters.search) params.append("search", filters.search);
      filters.branchIds.forEach((id) => params.append("branch_id", id));
      filters.buckets.forEach((b) => params.append("bucket", b));
      filters.agentIds.forEach((id) => params.append("agent_id", id));
      if (filters.agentType !== "all") params.append("agent_type", filters.agentType);
      filters.companyIds.forEach((id) => params.append("company_id", id));
      filters.products.forEach((p) => params.append("product", p));
      filters.actionTypes.forEach((a) => params.append("action_type", a));
      filters.dispositionCodeIds.forEach((id) => params.append("disposition_code_id", id));
      filters.ptpStatuses.forEach((s) => params.append("ptp_status", s));

      // Trigger export download
      const response = await api.get("/reports/agent-activity/export", {
        params,
        responseType: "blob",
      });

      const url = URL.createObjectURL(response.data);
      const link = document.createElement("a");
      link.href = url;
      link.download = `agent-activity-${filters.date}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
      message.success("Export downloaded successfully");
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const handleRowClick = (record: AgentActivityRow) => {
    setSelectedCustomerId(record.customer_id);
  };

  return (
    <div style={{ padding: "24px" }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 24 }}>
        <Col>
          <Typography.Title level={2} style={{ margin: 0 }}>
            Agent Daily Activity
          </Typography.Title>
        </Col>
        <Col>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={handleExport}
            loading={loading}
          >
            Export to Excel
          </Button>
        </Col>
      </Row>

      <FilterBar
        filters={filters}
        options={options}
        loading={loading}
        onFilterChange={handleFilterChange}
      />

      <Spin spinning={loading} style={{ marginTop: 24 }}>
        <ActivityTable
          data={activity}
          loading={loading}
          total={totalCount}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onRowClick={handleRowClick}
        />
      </Spin>

      {selectedCustomerId && (
        <CustomerDetailDrawer
          customerId={selectedCustomerId}
          open={!!selectedCustomerId}
          onClose={() => setSelectedCustomerId(null)}
        />
      )}
    </div>
  );
}
