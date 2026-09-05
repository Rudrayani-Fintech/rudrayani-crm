import { Link, Navigate, Route, Routes } from "react-router-dom";
import { Button, Result, Spin } from "antd";
import { lazy } from "react";
import { useAuth } from "./auth/AuthContext";
import AppLayout from "./components/AppLayout";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import LoginPage from "./pages/LoginPage";
import { WorkScopeProvider } from "./scope/WorkScopeContext";

// Lazy: none of these are needed until after login, and most users only ever
// touch a handful of them (role-gated in AppLayout's nav) -- bundling all 15+
// admin pages into the initial load would bloat the login screen for no reason.
const AgentActivityPage = lazy(() => import("./pages/AgentActivityPage"));
const AllocationPage = lazy(() => import("./pages/AllocationPage"));
const AttendancePage = lazy(() => import("./pages/AttendancePage"));
const BranchesPage = lazy(() => import("./pages/BranchesPage"));
const BucketsPage = lazy(() => import("./pages/BucketsPage"));
const CompaniesPage = lazy(() => import("./pages/CompaniesPage"));
const CorrectionRequestsPage = lazy(() => import("./pages/CorrectionRequestsPage"));
const CustomersPage = lazy(() => import("./pages/CustomersPage"));
const DayPlanPage = lazy(() => import("./pages/DayPlanPage"));
const DepositsPage = lazy(() => import("./pages/DepositsPage"));
const DispositionsPage = lazy(() => import("./pages/DispositionsPage"));
const EmployeesPage = lazy(() => import("./pages/EmployeesPage"));
const FieldConfigPage = lazy(() => import("./pages/FieldConfigPage"));
const ImportPage = lazy(() => import("./pages/ImportPage"));
const ImportReviewPage = lazy(() => import("./pages/ImportReviewPage"));
const MyRequestsPage = lazy(() => import("./pages/MyRequestsPage"));
const MyWorklistPage = lazy(() => import("./pages/MyWorklistPage"));
const OrgChartPage = lazy(() => import("./pages/OrgChartPage"));
const PasswordResetRequestsPage = lazy(() => import("./pages/PasswordResetRequestsPage"));
const ReallocationRequestsPage = lazy(() => import("./pages/ReallocationRequestsPage"));
const TeamsPage = lazy(() => import("./pages/TeamsPage"));
const TrackingPage = lazy(() => import("./pages/TrackingPage"));

// Phase 15 (S4): the KPI Dashboard is gone -- "/" redirects to Agent Daily
// Activity, the new owner's landing page. But that page's own lookup-options
// effect unconditionally calls GET /employees (employees.view-gated, see
// AppLayout.tsx's nav check), so a plain telecaller/field_agent (holding
// only reports.view_self, never employees.view) landing there by default
// would eat a guaranteed error toast and empty filter dropdowns on every
// login -- confirmed by reading AgentActivityPage.tsx directly, not
// something Phase 15's file list (App.tsx, AppLayout.tsx only) authorizes
// fixing at the source. Individual contributors redirect to their own
// worklist instead, matching what the deleted Dashboard's "My Performance"
// label used to mean for them.
function IndexRedirect() {
  const { hasPermission } = useAuth();
  return <Navigate to={hasPermission("reports.view") ? "/agent-activity" : "/my-worklist"} replace />;
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

// A mistyped or stale URL previously bounced silently to the dashboard --
// indistinguishable from "you clicked Dashboard", so a broken bookmark or
// shared link never got reported. This tells the user what happened.
function NotFoundPage() {
  return (
    <Result
      status="404"
      title="Page not found"
      subTitle="That link doesn't match any page in the portal."
      extra={
        <Link to="/">
          <Button type="primary">Back home</Button>
        </Link>
      }
    />
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <WorkScopeProvider>
              <AppLayout />
            </WorkScopeProvider>
          </RequireAuth>
        }
      >
        <Route index element={<IndexRedirect />} />
        <Route path="agent-activity" element={<AgentActivityPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="org-chart" element={<OrgChartPage />} />
        <Route path="branches" element={<BranchesPage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="companies" element={<CompaniesPage />} />
        <Route path="buckets" element={<BucketsPage />} />
        <Route path="field-config" element={<FieldConfigPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="import-reviews" element={<ImportReviewPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="my-worklist" element={<MyWorklistPage />} />
        <Route path="my-requests" element={<MyRequestsPage />} />
        <Route path="allocation" element={<AllocationPage />} />
        <Route path="reallocation-requests" element={<ReallocationRequestsPage />} />
        <Route path="correction-requests" element={<CorrectionRequestsPage />} />
        <Route path="password-reset-requests" element={<PasswordResetRequestsPage />} />
        <Route path="dispositions" element={<DispositionsPage />} />
        <Route path="tracking" element={<TrackingPage />} />
        <Route path="day-plan" element={<DayPlanPage />} />
        <Route path="deposits" element={<DepositsPage />} />
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
