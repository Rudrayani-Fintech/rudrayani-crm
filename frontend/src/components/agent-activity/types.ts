// API response types matching backend AgentActivityRow
export interface AgentActivityRow {
  kind: "call" | "payment" | "ptp" | "field_visit";
  id: string;
  at: string;
  agent_id: string;
  agent_name: string;
  agent_type: "telecaller" | "field_agent" | null;
  customer_id: string;
  customer_name: string;
  loan_number: string;
  customer_branch_id: string | null;
  customer_branch_name: string | null;
  customer_bucket: string | null;
  customer_company_id: string;
  customer_company_name: string;
  customer_mobile: string | null;
  customer_product: string | null;
  customer_pos: string | null;
  customer_emi: string | null;
  customer_due_amount: string | null;
  ptp_status: "pending" | "kept" | "broken" | null;
  remark: string | null;
  amount: string | null;
  detail: string | null;
  disposition_description: string | null;
}

export interface AgentActivityResponse {
  agent_id: string | null;
  activity: AgentActivityRow[];
  total_count: number;
  page: number;
  limit: number;
  total_pages: number;
}

// Filter state
export interface FilterState {
  // Primary filters
  date: string; // YYYY-MM-DD
  search: string;
  branchIds: string[];
  buckets: string[];
  agentIds: string[];
  agentType: "all" | "telecaller" | "field_agent";
  // Secondary filters
  companyIds: string[];
  products: string[];
  actionTypes: ("call" | "payment" | "ptp" | "field_visit")[];
  dispositionCodeIds: string[];
  ptpStatuses: ("pending" | "kept" | "broken")[];
}

// Lookup options for dropdowns
export interface LookupOptions {
  branches: Array<{ id: string; name: string }>;
  buckets: string[];
  agents: Array<{ id: string; full_name: string }>;
  companies: Array<{ id: string; name: string }>;
  products: string[];
  dispositionCodes: Array<{ id: string; action_code: string; description?: string }>;
}
