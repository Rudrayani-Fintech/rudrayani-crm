export type Capability =
  | "agency_admin"
  | "operations_manager"
  | "branch_manager"
  | "telecaller"
  | "field_agent";

export type Designation =
  | "agency_admin"
  | "operations_manager"
  | "branch_manager"
  | "telecaller"
  | "field_agent";

export type AgentType = "telecaller" | "field_agent";

export interface User {
  id: string;
  agency_id: string;
  branch_id: string | null;
  branch_ids?: string[]; // Multi-branch for telecaller-type work
  team_id: string | null;
  team_ids?: string[]; // Multi-team for telecaller-type work
  manager_id: string | null;
  manager_name?: string | null;
  managed_branch_id?: string | null;
  full_name: string;
  phone: string;
  email: string | null;
  designation?: Designation;
  agent_type?: AgentType | null;
  capabilities: Capability[];
}

export interface Employee extends User {
  is_active: boolean;
  /** Only present when GET /employees is called with with_load=true (the
   * allocation agent picker) -- omitted elsewhere to avoid paying for the
   * subquery on every plain employee-list load. */
  assigned_count?: number;
}

export interface NodePerformance {
  collected_amount: number;
  target_amount: number | null;
  achievement_pct: number | null;
}

/** A node in the org-chart tree (GET /employees/org-hierarchy). */
export interface OrgAgent extends Employee {
  manager_name: string | null;
  performance?: NodePerformance | null;
}

export interface OrgTeam {
  id: string;
  name: string;
  agents: OrgAgent[];
  performance?: NodePerformance | null;
}

export interface OrgBranch {
  id: string;
  name: string;
  branch_manager: { id: string; full_name: string | null } | null;
  teams: OrgTeam[];
  unassigned_agents: OrgAgent[];
  performance?: NodePerformance | null;
}

export interface OrgHierarchy {
  agency: { id: string; name: string } | null;
  branches: OrgBranch[];
  unassigned_agents: OrgAgent[];
}

export interface Branch {
  id: string;
  name: string;
  created_at: string;
  branch_manager_id?: string | null;
  branch_manager_name?: string | null;
}

export interface Team {
  id: string;
  name: string;
  branch_id: string;
  branch_name?: string;
  created_at: string;
}

export interface Company {
  id: string;
  name: string;
  created_at: string;
}

export interface ImportTemplate {
  id: string;
  company_id: string;
  name: string;
  column_mapping: Record<string, string>;
  detail_fields: string[];
  version: number;
  is_active: boolean;
  created_at: string;
}

export interface ImportRun {
  id: string;
  company_id: string;
  mode: "new" | "allocation";
  template_id: string | null;
  template_name: string | null;
  file_name: string | null;
  uploaded_by_name: string | null;
  inserted_rows: number;
  duplicate_rows: number;
  error_rows: number;
  created_at: string;
  deleted_at: string | null;
  rolled_back_at: string | null;
}

export interface DispositionCode {
  id: string;
  action_code: string;
  category: string | null;
  result_code: string | null;
  description: string;
  remark_template: string | null;
  // FV (field visit) or OC (on-call) -- NULL for legacy/custom codes an
  // admin hasn't tagged yet.
  channel: "FV" | "OC" | null;
  needs_amount: boolean;
  needs_date: boolean;
  needs_time: boolean;
  needs_mode: boolean;
  needs_reason: boolean;
  needs_name_relation: boolean;
  is_active: boolean;
}

export interface Customer {
  id: string;
  loan_number: string;
  customer_name: string;
  mobile_number: string | null;
  product: string | null;
  bucket: string | null;
  due_amount: string | null;
  pos: string | null;
  emi: string | null;
  status: "active" | "closed" | "recalled";
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  assigned_field_agent_id: string | null;
  assigned_field_agent_name: string | null;
  branch_id: string | null;
  branch_name?: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  company_name: string;
  company_id: string;
}

/**
 * GET /worklist's response shape -- deliberately NOT the same as Customer.
 * It's scoped to "assigned to me" and carries call/PTP context Customer
 * doesn't have, while omitting fields (status, assigned_agent_id, etc.)
 * that don't apply to a self-scoped worklist.
 */
export interface WorklistCustomer {
  id: string;
  loan_number: string;
  customer_name: string;
  mobile_number: string | null;
  product: string | null;
  bucket: string | null;
  due_amount: string | null;
  pos: string | null;
  emi: string | null;
  custom_fields: Record<string, unknown>;
  company_name: string;
  branch_name?: string | null;
  is_primary_for_me: boolean;
  is_field_agent_for_me: boolean;
  assigned_agent_name?: string | null;
  assigned_field_agent_name?: string | null;
  last_remark: string | null;
  last_call_at: string | null;
  last_result_code: string | null;
  ptp_amount: string | null;
  ptp_date: string | null;
  normalized_pending: boolean;
}

export interface AllocationLog {
  id: string;
  reason: string | null;
  created_at: string;
  slot: "primary" | "field";
  from_agent_name: string | null;
  to_agent_name: string;
  allocated_by_name: string;
}

export type ReviewItemType = "addition" | "removal" | "reactivation" | "update";
export type ReviewItemStatus = "pending" | "approved" | "rejected" | "superseded";

export interface ReviewItem {
  id: string;
  item_type: ReviewItemType;
  loan_number: string;
  status: ReviewItemStatus;
  payload: {
    customer_name?: string | null;
    mobile_number?: string | null;
    product?: string | null;
    bucket?: string | null;
    due_amount?: number | null;
    pos?: number | null;
    emi?: number | null;
    agent_phone?: string | null;
    custom_fields?: Record<string, string>;
  };
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  file_name: string | null;
  allocation_month: string | null;
  current_customer_name: string | null;
  current_bucket: string | null;
  current_due_amount: string | null;
  current_pos: string | null;
  current_status: string | null;
  current_agent_name: string | null;
}

export type ReallocationStatus = "pending" | "approved" | "rejected";

export interface ReallocationRequest {
  id: string;
  reason: string;
  status: ReallocationStatus;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  customer_id: string;
  loan_number: string;
  customer_name: string;
  due_amount: string | null;
  pos: string | null;
  company_name: string;
  requested_by_id: string;
  requested_by_name: string;
  decided_by_name: string | null;
}

export const CAPABILITY_LABELS: Record<Capability, string> = {
  agency_admin: "Agency Admin",
  operations_manager: "Operations Manager",
  branch_manager: "Branch Manager",
  telecaller: "Telecaller",
  field_agent: "Field Agent",
};

export const SYSTEM_FIELD_LABELS: Record<string, string> = {
  loan_number: "Loan Number (required)",
  customer_name: "Customer Name (required)",
  mobile_number: "Mobile Number",
  product: "Product",
  bucket: "Bucket",
  due_amount: "Due Amount",
  pos: "POS (Principal Outstanding)",
  emi: "EMI Amount",
};
