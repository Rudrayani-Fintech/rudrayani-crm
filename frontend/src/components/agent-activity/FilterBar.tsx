import { DatePicker, Input, Select, Segmented, Button, Space, Row, Col, Collapse, Checkbox, theme } from "antd";
import { SearchOutlined, ClearOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import type { FilterState, LookupOptions } from "./types";

interface FilterBarProps {
  filters: FilterState;
  options: LookupOptions;
  loading?: boolean;
  onFilterChange: (filters: FilterState) => void;
}

export default function FilterBar({ filters, options, loading, onFilterChange }: FilterBarProps) {
  const { token } = theme.useToken();
  const [localSearch, setLocalSearch] = useState(filters.search);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      onFilterChange({ ...filters, search: localSearch });
    }, 400);
    return () => clearTimeout(timer);
  }, [localSearch]);

  const handleDateChange = (date: Dayjs | null) => {
    if (date) {
      onFilterChange({ ...filters, date: date.format("YYYY-MM-DD") });
    }
  };

  const handleBranchChange = (branchIds: string[]) => {
    onFilterChange({ ...filters, branchIds });
  };

  const handleBucketChange = (buckets: string[]) => {
    onFilterChange({ ...filters, buckets });
  };

  const handleAgentChange = (agentIds: string[]) => {
    onFilterChange({ ...filters, agentIds });
  };

  const handleAgentTypeChange = (value: string) => {
    onFilterChange({ ...filters, agentType: value as FilterState["agentType"] });
  };

  const handleCompanyChange = (companyIds: string[]) => {
    onFilterChange({ ...filters, companyIds });
  };

  const handleProductChange = (products: string[]) => {
    onFilterChange({ ...filters, products });
  };

  const handleActionTypeChange = (actionTypes: ("call" | "payment" | "ptp" | "field_visit")[]) => {
    onFilterChange({ ...filters, actionTypes });
  };

  const handleDispositionChange = (dispositionCodeIds: string[]) => {
    onFilterChange({ ...filters, dispositionCodeIds });
  };

  const handlePtpStatusChange = (ptpStatuses: ("pending" | "kept" | "broken")[]) => {
    onFilterChange({ ...filters, ptpStatuses });
  };

  const handleClearFilters = () => {
    onFilterChange({
      date: dayjs().format("YYYY-MM-DD"),
      search: "",
      branchIds: [],
      buckets: [],
      agentIds: [],
      agentType: "all",
      companyIds: [],
      products: [],
      actionTypes: ["call", "payment", "ptp", "field_visit"],
      dispositionCodeIds: [],
      ptpStatuses: [],
    });
    setLocalSearch("");
  };

  // Count active secondary filters
  const secondaryFilterCount =
    (filters.companyIds.length > 0 ? 1 : 0) +
    (filters.products.length > 0 ? 1 : 0) +
    (filters.actionTypes.length < 4 ? 1 : 0) +
    (filters.dispositionCodeIds.length > 0 ? 1 : 0) +
    (filters.ptpStatuses.length > 0 ? 1 : 0);

  return (
    <div style={{ padding: token.padding, backgroundColor: token.colorBgContainer, marginBottom: token.margin }}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {/* Primary filter row */}
        <Row gutter={[token.margin, token.margin]} align="middle">
          <Col xs={24} sm={12} md={4}>
            <DatePicker
              value={dayjs(filters.date)}
              onChange={handleDateChange}
              format="DD MMM YYYY"
              style={{ width: "100%" }}
              disabled={loading}
            />
          </Col>
          <Col xs={24} sm={12} md={5}>
            <Input
              placeholder="Search customer, loan, phone..."
              prefix={<SearchOutlined />}
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              disabled={loading}
              allowClear
            />
          </Col>
          <Col xs={24} sm={12} md={5}>
            <Select
              mode="multiple"
              placeholder="Select branch..."
              options={options.branches.map((b) => ({ label: b.name, value: b.id }))}
              value={filters.branchIds}
              onChange={handleBranchChange}
              showSearch
              maxTagCount="responsive"
              allowClear
              disabled={loading}
              style={{ width: "100%" }}
            />
          </Col>
          <Col xs={24} sm={12} md={4}>
            <Select
              mode="multiple"
              placeholder="Select bucket..."
              options={options.buckets.map((b) => ({ label: b, value: b }))}
              value={filters.buckets}
              onChange={handleBucketChange}
              maxTagCount="responsive"
              allowClear
              disabled={loading}
              style={{ width: "100%" }}
            />
          </Col>
        </Row>

        <Row gutter={[token.margin, token.margin]} align="middle">
          <Col xs={24} sm={12} md={6}>
            <Select
              mode="multiple"
              placeholder="Select agent..."
              options={options.agents.map((a) => ({ label: a.full_name, value: a.id }))}
              value={filters.agentIds}
              onChange={handleAgentChange}
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              allowClear
              disabled={loading}
              style={{ width: "100%" }}
            />
          </Col>
          <Col xs={24} sm={12} md={4}>
            <Segmented
              options={[
                { label: "All", value: "all" },
                { label: "Telecaller", value: "telecaller" },
                { label: "Field Agent", value: "field_agent" },
              ]}
              value={filters.agentType}
              onChange={handleAgentTypeChange}
              disabled={loading}
              block
            />
          </Col>
          <Col xs={24} sm={24} md="auto">
            <Space>
              <Collapse
                items={[
                  {
                    key: "1",
                    label: `More Filters ${secondaryFilterCount > 0 ? `(${secondaryFilterCount})` : ""}`,
                    children: (
                      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                        <Row gutter={[token.margin, token.margin]}>
                          <Col xs={24} sm={12} md={4}>
                            <Select
                              mode="multiple"
                              placeholder="Select company..."
                              options={options.companies.map((c) => ({ label: c.name, value: c.id }))}
                              value={filters.companyIds}
                              onChange={handleCompanyChange}
                              showSearch
                              maxTagCount="responsive"
                              allowClear
                              disabled={loading}
                              style={{ width: "100%" }}
                            />
                          </Col>
                          <Col xs={24} sm={12} md={4}>
                            <Select
                              mode="multiple"
                              placeholder="Select product..."
                              options={options.products.map((p) => ({ label: p, value: p }))}
                              value={filters.products}
                              onChange={handleProductChange}
                              maxTagCount="responsive"
                              allowClear
                              disabled={loading}
                              style={{ width: "100%" }}
                            />
                          </Col>
                          <Col xs={24} sm={12} md={6}>
                            <div style={{ marginBottom: token.marginSM }}>Action Type</div>
                            <Checkbox.Group
                              options={[
                                { label: "Call", value: "call" },
                                { label: "Payment", value: "payment" },
                                { label: "PTP", value: "ptp" },
                                { label: "Field Visit", value: "field_visit" },
                              ]}
                              value={filters.actionTypes}
                              onChange={(values) =>
                                handleActionTypeChange(values as ("call" | "payment" | "ptp" | "field_visit")[])
                              }
                              disabled={loading}
                            />
                          </Col>
                        </Row>
                        <Row gutter={[token.margin, token.margin]}>
                          <Col xs={24} sm={12} md={6}>
                            <Select
                              mode="multiple"
                              placeholder="Select disposition..."
                              options={options.dispositionCodes.map((d) => ({
                                label: `${d.action_code}${d.description ? ` - ${d.description}` : ""}`,
                                value: d.id,
                              }))}
                              value={filters.dispositionCodeIds}
                              onChange={handleDispositionChange}
                              showSearch
                              optionFilterProp="label"
                              maxTagCount="responsive"
                              allowClear
                              disabled={loading}
                              style={{ width: "100%" }}
                            />
                          </Col>
                          <Col xs={24} sm={12} md={4}>
                            <div style={{ marginBottom: token.marginSM }}>PTP Status</div>
                            <Checkbox.Group
                              options={[
                                { label: "Pending", value: "pending" },
                                { label: "Kept", value: "kept" },
                                { label: "Broken", value: "broken" },
                              ]}
                              value={filters.ptpStatuses}
                              onChange={(values) =>
                                handlePtpStatusChange(values as ("pending" | "kept" | "broken")[])
                              }
                              disabled={loading}
                            />
                          </Col>
                        </Row>
                      </Space>
                    ),
                  },
                ]}
                style={{ marginBottom: 0 }}
              />
              <Button
                icon={<ClearOutlined />}
                onClick={handleClearFilters}
                disabled={loading}
              >
                Clear filters
              </Button>
            </Space>
          </Col>
        </Row>
      </Space>
    </div>
  );
}
