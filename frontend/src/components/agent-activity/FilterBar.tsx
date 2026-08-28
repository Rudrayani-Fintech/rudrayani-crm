import { DatePicker, Input, Select, Segmented, Button, Space, Row, Col, theme } from "antd";
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

  const handleClearFilters = () => {
    onFilterChange({
      date: dayjs().format("YYYY-MM-DD"),
      search: "",
      branchIds: [],
      buckets: [],
      agentIds: [],
      agentType: "all",
    });
    setLocalSearch("");
  };

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
            <Button
              icon={<ClearOutlined />}
              onClick={handleClearFilters}
              disabled={loading}
            >
              Clear filters
            </Button>
          </Col>
        </Row>
      </Space>
    </div>
  );
}
