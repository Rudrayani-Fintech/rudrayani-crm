import { Layout, Menu, Spin, Typography, Space, Switch, Tag, Button, Tooltip } from "antd";
import { Suspense, useState } from "react";
import {
  ApartmentOutlined,
  AuditOutlined,
  CalendarOutlined,
  EnvironmentOutlined,
  FilterOutlined,
  WalletOutlined,
  FileSearchOutlined,
  FileSyncOutlined,
  FlagOutlined,
  KeyOutlined,
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
import { useWorkScope } from "../scope/WorkScopeContext";

const { Sider, Header, Content } = Layout;

export default function AppLayout() {
  const { user, hasPermission, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, toggle } = useThemeMode();
  const { myWorkOnly, setMyWorkOnly } = useWorkScope();
  // A dual-capability user (works their own book AND manages a team/branch)
  // previously had to reconcile three separate, differently-labelled
  // controls across two pages to mean the same thing. One switch, here,
  // drives all of them now.
  const hasAgentWork = !!user?.agent_type;
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
    hasPermission("reports.view") && {
      key: "/agent-activity",
      icon: <UnorderedListOutlined />,
      label: <Link to="/agent-activity">Agent Daily Activity</Link>,
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
    // Phase 16 (A4): same gate as GET /password-reset-requests itself
    // (employees.view) -- branch-scoped server-side, same as Employees.
    hasPermission("employees.view") && {
      key: "/password-reset-requests",
      icon: <KeyOutlined />,
      label: <Link to="/password-reset-requests">Password Reset Requests</Link>,
    },
    hasPermission("dispositions.manage") && {
      key: "/dispositions",
      icon: <AuditOutlined />,
      label: <Link to="/dispositions">Dispositions</Link>,
    },
    // Phase 15 (S5, F4): tracking.view alone (self-scoped) stays with every
    // telecaller/field_agent so their own attendance/mobile session still
    // works -- these three nav items specifically are the *team-visibility*
    // surface (live map, day plan across a team, attendance across a team),
    // gated on tracking.view_team, not the broader tracking.view.
    hasPermission("tracking.view_team") && {
      key: "/tracking",
      icon: <EnvironmentOutlined />,
      label: <Link to="/tracking">Tracking</Link>,
    },
    hasPermission("tracking.view_team") && {
      key: "/day-plan",
      icon: <CalendarOutlined />,
      label: <Link to="/day-plan">Day Plan</Link>,
    },
    hasPermission("tracking.view_team") && {
      key: "/attendance",
      icon: <ScheduleOutlined />,
      label: <Link to="/attendance">Attendance</Link>,
    },
    hasPermission("payments.deposit") && {
      key: "/deposits",
      icon: <WalletOutlined />,
      label: <Link to="/deposits">Deposits</Link>,
    },
  ].filter(Boolean) as { key: string }[];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <style>{`
        /* The header row (name, My Team/Work toggle, theme toggle, alerts,
           capability tags, logout) previously had no wrap/overflow guard
           and no narrow-screen fallback -- on a phone-width viewport it
           either broke the page's own layout or clipped the logout button.
           Capability tags are the least essential item here, so they're
           the first to go; app-header itself scrolls as a last resort. */
        @media (max-width: 600px) {
          .header-capability-tags { display: none; }
        }
      `}</style>
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
          className="app-header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingInline: 24,
            overflowX: "auto",
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
            {hasAgentWork && (
              <Space size={6}>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  My Team/Branch
                </Typography.Text>
                <Switch checked={myWorkOnly} onChange={setMyWorkOnly} size="small" />
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  My Work
                </Typography.Text>
              </Space>
            )}
            <Tooltip title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
              <Button
                type="text"
                shape="circle"
                icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
                onClick={toggle}
              />
            </Tooltip>
            <AlertsBell />
            <span className="header-capability-tags">
              {user?.capabilities.map((c) => (
                <Tag color="blue" key={c}>
                  {CAPABILITY_LABELS[c]}
                </Tag>
              ))}
            </span>
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
