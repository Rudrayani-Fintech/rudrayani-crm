import { Layout, Menu, Spin, Typography, Space, Tag, Button, Tooltip } from "antd";
import { Suspense, useState } from "react";
import {
  ApartmentOutlined,
  AuditOutlined,
  BarChartOutlined,
  CalendarOutlined,
  DashboardOutlined,
  AimOutlined,
  EnvironmentOutlined,
  FilterOutlined,
  WalletOutlined,
  FileSearchOutlined,
  FileSyncOutlined,
  FlagOutlined,
  LogoutOutlined,
  MenuOutlined,
  MoonOutlined,
  ScheduleOutlined,
  SettingOutlined,
  SunOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useThemeMode } from "../theme/ThemeModeProvider";
import { CAPABILITY_LABELS } from "../types";
import AlertsBell from "./AlertsBell";
import ErrorBoundary from "./ErrorBoundary";

const { Sider, Header, Content } = Layout;

export default function AppLayout() {
  const { user, hasPermission, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, toggle } = useThemeMode();
  // Sider's own breakpoint="lg" collapses it to 0 width below 992px with no
  // way back in -- there was no trigger anywhere to reopen it, so the whole
  // nav simply vanished on a phone. Controlling it ourselves with a header
  // button (shown at every width, not just mobile -- harmless on desktop
  // too) means there's always a way to bring it back.
  const [navCollapsed, setNavCollapsed] = useState(false);

  // Menu assembled from active capabilities/permissions (brief §3).
  // A caller with calls.log but not customers.allocate is a plain
  // telecaller/field_agent -- TL/ops/admin hold both, so this is the
  // precise "individual contributor, not a manager" test used throughout.
  const isIndividualContributor = hasPermission("calls.log") && !hasPermission("customers.allocate");
  // Previously gated entirely on operations_manager/agency_admin, which hid
  // Branches/Teams/Employees/Org Chart from a branch_manager even though the
  // backend grants them employees.view/employees.create/branches.manage/
  // teams.manage -- they could see their own branch's data through the API
  // but had no nav path to reach it. Gate per-item on the actual permission
  // (as every other nav item already does) and only show the submenu at all
  // once at least one child is visible.
  const organizationChildren = [
    hasPermission("companies.manage") && {
      key: "/companies",
      label: <Link to="/companies">Companies</Link>,
    },
    hasPermission("branches.manage") && {
      key: "/branches",
      label: <Link to="/branches">Branches</Link>,
    },
    hasPermission("teams.manage") && {
      key: "/teams",
      label: <Link to="/teams">Teams</Link>,
    },
    hasPermission("employees.view") && {
      key: "/employees",
      label: <Link to="/employees">Employees</Link>,
    },
    hasPermission("employees.view") && {
      key: "/org-chart",
      label: <Link to="/org-chart">Org Chart</Link>,
    },
  ].filter(Boolean);
  const items = [
    {
      key: "/",
      icon: <DashboardOutlined />,
      label: <Link to="/">{hasPermission("reports.view") ? "Dashboard" : "My Performance"}</Link>,
    },
    hasPermission("reports.view") && {
      key: "/management-dashboard",
      icon: <BarChartOutlined />,
      label: <Link to="/management-dashboard">Management Dashboard</Link>,
    },
    // Shown to anyone who personally logs calls -- not just individual
    // contributors. Branch managers/ops managers hold customers.allocate
    // too, but still need their own properly-scoped book (GET /worklist is
    // always self-scoped, or self+team for a branch_manager's "Team" toggle)
    // rather than being stuck on the org-wide Customers list.
    hasPermission("calls.log") && {
      key: "/my-worklist",
      icon: <UnorderedListOutlined />,
      label: <Link to="/my-worklist">My Worklist</Link>,
    },
    isIndividualContributor && {
      key: "/my-requests",
      icon: <FileSyncOutlined />,
      label: <Link to="/my-requests">My Requests</Link>,
    },
    organizationChildren.length > 0 && {
      key: "organization",
      icon: <ApartmentOutlined />,
      label: "Organization",
      children: organizationChildren,
    },
    hasPermission("companies.manage") && {
      key: "/buckets",
      icon: <FilterOutlined />,
      label: <Link to="/buckets">Buckets</Link>,
    },
    hasPermission("companies.manage") && {
      key: "/field-config",
      icon: <SettingOutlined />,
      label: <Link to="/field-config">Field Config</Link>,
    },
    hasPermission("imports.manage") && {
      key: "/import",
      icon: <UploadOutlined />,
      label: <Link to="/import">Import</Link>,
    },
    hasPermission("imports.review") && {
      key: "/import-reviews",
      icon: <FileSyncOutlined />,
      label: <Link to="/import-reviews">Import Review</Link>,
    },
    // Hidden for a plain telecaller/field_agent: after the GET /customers
    // scoping fix, it's a strict, less-useful subset of My Worklist above
    // (no last-call/PTP context) -- two nav items pointing at overlapping
    // data. The route itself stays reachable directly, it's just not linked.
    hasPermission("customers.view") && !isIndividualContributor && {
      key: "/customers",
      icon: <UnorderedListOutlined />,
      label: <Link to="/customers">Customers</Link>,
    },
    hasPermission("customers.allocate") && {
      key: "/allocation",
      icon: <FileSearchOutlined />,
      label: <Link to="/allocation">Allocation</Link>,
    },
    hasPermission("customers.allocate") && {
      key: "/reallocation-requests",
      icon: <FileSyncOutlined />,
      label: <Link to="/reallocation-requests">Reallocation Requests</Link>,
    },
    hasPermission("customers.allocate") && {
      key: "/correction-requests",
      icon: <FlagOutlined />,
      label: <Link to="/correction-requests">Correction Requests</Link>,
    },
    hasPermission("dispositions.manage") && {
      key: "/dispositions",
      icon: <AuditOutlined />,
      label: <Link to="/dispositions">Dispositions</Link>,
    },
    hasPermission("tracking.view") && {
      key: "/tracking",
      icon: <EnvironmentOutlined />,
      label: <Link to="/tracking">Tracking</Link>,
    },
    hasPermission("tracking.view") && {
      key: "/day-plan",
      icon: <CalendarOutlined />,
      label: <Link to="/day-plan">Day Plan</Link>,
    },
    hasPermission("tracking.view") && {
      key: "/attendance",
      icon: <ScheduleOutlined />,
      label: <Link to="/attendance">Attendance</Link>,
    },
    hasPermission("targets.manage") && {
      key: "/targets",
      icon: <AimOutlined />,
      label: <Link to="/targets">Targets</Link>,
    },
    hasPermission("payments.deposit") && {
      key: "/deposits",
      icon: <WalletOutlined />,
      label: <Link to="/deposits">Deposits</Link>,
    },
  ].filter(Boolean) as { key: string }[];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        breakpoint="lg"
        collapsedWidth={0}
        collapsed={navCollapsed}
        onCollapse={setNavCollapsed}
        onBreakpoint={setNavCollapsed}
        trigger={null}
      >
        <div style={{ color: "white", padding: 16, fontWeight: 700, fontSize: 16 }}>
          <TeamOutlined /> Rudrayani CRM
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={items as never}
          onClick={() => {
            // Auto-close after navigating on a phone-width screen so the
            // nav doesn't stay covering the page -- desktop is unaffected.
            if (window.innerWidth < 992) setNavCollapsed(true);
          }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingInline: 24,
          }}
        >
          <Space>
            <Button
              type="text"
              shape="circle"
              icon={<MenuOutlined />}
              onClick={() => setNavCollapsed(!navCollapsed)}
              aria-label="Toggle navigation"
            />
            <Typography.Text strong>{user?.full_name}</Typography.Text>
          </Space>
          <Space>
            <Tooltip title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
              <Button
                type="text"
                shape="circle"
                icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
                onClick={toggle}
              />
            </Tooltip>
            <AlertsBell />
            {user?.capabilities.map((c) => (
              <Tag color="blue" key={c}>
                {CAPABILITY_LABELS[c]}
              </Tag>
            ))}
            <Button
              icon={<LogoutOutlined />}
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              Logout
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 24 }}>
          <ErrorBoundary key={location.pathname}>
            <Suspense
              fallback={
                <div style={{ display: "grid", placeItems: "center", height: 320 }}>
                  <Spin size="large" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </Content>
      </Layout>
    </Layout>
  );
}
