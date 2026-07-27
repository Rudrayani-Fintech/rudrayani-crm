import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { AimOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import L from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../api/client";
import { refreshLiveTracking, subscribeLiveTracking, type LiveAgent } from "../api/liveTracking";
import { useAuth } from "../auth/AuthContext";
import { alertText } from "../components/AlertsBell";
import { palette } from "../theme/tokens";

// Default map center (Pune) used only before any data arrives.
const FALLBACK_CENTER: [number, number] = [18.5204, 73.8567];

interface RoutePoint {
  recorded_at: string;
  lat: number;
  lng: number;
}

const STATUS_META: Record<LiveAgent["status"], { color: string; label: string }> = {
  moving: { color: palette.emerald, label: "Moving" },
  stationary: { color: palette.destructive, label: "Stationary" },
  no_signal: { color: palette.warning, label: "No signal" },
  awaiting_first_ping: { color: palette.textMuted, label: "Awaiting first ping" },
};

// A server-added status value the frontend hasn't been updated for yet
// should render as an unlabeled dot, not throw and blank the whole map.
const statusMeta = (s: string) => STATUS_META[s as LiveAgent["status"]] ?? { color: palette.textMuted, label: s };

/** Colored dot marker — avoids Leaflet's bundler-hostile image icons. */
function dotIcon(color: string, highlight: boolean) {
  return L.divIcon({
    className: "",
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};
           border:3px solid white;box-shadow:0 0 4px rgba(0,0,0,.5)
           ${highlight ? ";outline:3px solid " + color + "55" : ""}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

/** Fits the map to the given positions whenever they meaningfully change. */
function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  const key = positions.map((p) => p.join(",")).join(";");
  const lastKey = useRef("");
  useEffect(() => {
    if (positions.length === 0 || key === lastKey.current) return;
    lastKey.current = key;
    map.fitBounds(L.latLngBounds(positions), { padding: [40, 40], maxZoom: 16 });
  }, [key, map, positions]);
  return null;
}

function LiveMap() {
  const [agents, setAgents] = useState<LiveAgent[]>([]);
  const [thresholds, setThresholds] = useState({ stationary_minutes: 20 });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Dayjs | null>(null);

  useEffect(() => {
    return subscribeLiveTracking((data, err) => {
      setLoading(false);
      if (err || !data) {
        message.error("Could not load live positions");
        return;
      }
      setAgents(data.agents);
      setThresholds(data.thresholds);
      setLastUpdated(dayjs());
    });
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    void refreshLiveTracking();
  }, []);

  const located = agents.filter((a): a is LiveAgent & { lat: number; lng: number } =>
    a.lat !== null && a.lng !== null,
  );
  const alerts = agents.filter(
    (a): a is LiveAgent & { status: "stationary" | "no_signal" } =>
      a.status === "stationary" || a.status === "no_signal",
  );
  const positions = useMemo(
    () => located.map((a) => [a.lat, a.lng] as [number, number]),
    [located],
  );

  const columns = [
    { title: "Agent", dataIndex: "full_name" },
    { title: "Team", dataIndex: "team_name", render: (v: string | null) => v ?? "—" },
    {
      title: "Status",
      dataIndex: "status",
      render: (s: LiveAgent["status"], row: LiveAgent) => (
        <Tag color={statusMeta(s).color}>
          {statusMeta(s).label}
          {s === "stationary" && ` ${row.stationary_minutes} min`}
        </Tag>
      ),
    },
    {
      title: "Last ping",
      dataIndex: "last_ping_at",
      render: (v: string | null) => (v ? dayjs(v).format("HH:mm:ss") : "—"),
    },
    {
      title: "Punched in",
      dataIndex: "punch_in_at",
      render: (v: string) => dayjs(v).format("HH:mm"),
    },
  ];

  if (loading) return <Spin style={{ display: "block", margin: "80px auto" }} size="large" />;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={16}>
      {alerts.length > 0 && (
        <Alert
          type={alerts.some((a) => a.status === "stationary") ? "error" : "warning"}
          showIcon
          message={`${alerts.length} tracking alert${alerts.length > 1 ? "s" : ""} — stationary threshold ${thresholds.stationary_minutes} min`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {alerts.map((a) => (
                <li key={a.user_id}>
                  <b>{a.full_name}</b>
                  {a.team_name ? ` (${a.team_name})` : ""} — {alertText(a)}
                  {a.status === "stationary" &&
                    a.stationary_since &&
                    ` (since ${dayjs(a.stationary_since).format("HH:mm")})`}
                </li>
              ))}
            </ul>
          }
        />
      )}
      <Space>
        <Button icon={<ReloadOutlined />} onClick={load}>
          Refresh
        </Button>
        <Typography.Text type="secondary">
          {agents.length} on duty · auto-refreshes every 30s
          {lastUpdated && ` · updated ${lastUpdated.format("HH:mm:ss")}`}
        </Typography.Text>
      </Space>
      {agents.length === 0 ? (
        <Empty description="No one is punched in right now" />
      ) : (
        <>
          <MapContainer
            center={FALLBACK_CENTER}
            zoom={12}
            style={{ height: 440, borderRadius: 8 }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FitBounds positions={positions} />
            {located.map((a) => (
              <Marker
                key={a.user_id}
                position={[a.lat, a.lng]}
                icon={dotIcon(statusMeta(a.status).color, a.status === "stationary")}
              >
                <Tooltip direction="top" offset={[0, -10]}>
                  {a.full_name}
                </Tooltip>
                <Popup>
                  <b>{a.full_name}</b> · {a.phone}
                  <br />
                  {a.team_name ?? "No team"} {a.branch_name ? `· ${a.branch_name}` : ""}
                  <br />
                  Status: {statusMeta(a.status).label}
                  {a.status === "stationary" && ` for ${a.stationary_minutes} min`}
                  <br />
                  Last ping: {a.last_ping_at ? dayjs(a.last_ping_at).format("HH:mm:ss") : "—"}
                  {a.accuracy_meters != null && ` (±${Math.round(a.accuracy_meters)}m)`}
                </Popup>
              </Marker>
            ))}
          </MapContainer>
          <Table
            size="small"
            rowKey="user_id"
            columns={columns}
            dataSource={agents}
            pagination={false}
          />
        </>
      )}
    </Space>
  );
}

function RouteReplay() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState<
    { id: string; full_name: string; team_id: string | null }[]
  >([]);
  const [userId, setUserId] = useState<string>();
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [loading, setLoading] = useState(false);
  const [route, setRoute] = useState<{
    points: RoutePoint[];
    distance_meters: number;
    user: { full_name: string };
  } | null>(null);

  // Non-admin/ops users are scope-clamped server-side -- mirror that in the
  // dropdown instead of letting picks fail with a 404.
  // A branch_manager has no team_id of their own (their scope comes from
  // branches.branch_manager_id via resolveBranchClamp() instead), so
  // filtering by team_id equality made this picker under-show almost every
  // employee in their branch. The server's own /employees clamp already
  // restricts the response to their branch, so no client-side narrowing is
  // needed for them -- just show what the server already scoped.
  const isBranchManager = user?.designation === "branch_manager";
  const teamScoped =
    !isBranchManager &&
    (user?.capabilities.every((c) => !["agency_admin", "operations_manager"].includes(c)) ?? false);

  useEffect(() => {
    api
      .get("/employees")
      .then((res) => {
        const all = res.data.employees as typeof employees;
        setEmployees(teamScoped ? all.filter((e) => e.team_id === user?.team_id) : all);
      })
      .catch(() => message.error("Could not load employees"));
  }, [teamScoped, user?.team_id]);

  const load = async () => {
    if (!userId) {
      message.warning("Pick an employee first");
      return;
    }
    setLoading(true);
    try {
      const res = await api.get("/tracking/route", {
        params: { user_id: userId, date: date.format("YYYY-MM-DD") },
      });
      setRoute(res.data);
    } catch {
      message.error("Could not load the route");
      setRoute(null);
    } finally {
      setLoading(false);
    }
  };

  const positions = (route?.points ?? []).map((p) => [p.lat, p.lng] as [number, number]);
  const start = route?.points[0];
  const end = route?.points[route.points.length - 1];

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={16}>
      <Space wrap>
        <Select
          showSearch
          style={{ width: 260 }}
          title="Employee" placeholder="Employee"
          optionFilterProp="label"
          value={userId}
          onChange={setUserId}
          options={employees.map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <DatePicker
          value={date}
          allowClear={false}
          onChange={(d) => d && setDate(d)}
          disabledDate={(d) =>
            d.isAfter(dayjs(), "day") || d.isBefore(dayjs().subtract(60, "day"), "day")
          }
        />
        <Button type="primary" icon={<AimOutlined />} loading={loading} onClick={load}>
          Show route
        </Button>
        {route && (
          <Typography.Text strong>
            {route.points.length} pings · {(route.distance_meters / 1000).toFixed(2)} km
          </Typography.Text>
        )}
      </Space>
      {route &&
        (route.points.length === 0 ? (
          <Empty description="No location pings for this day (retention is 60 days)" />
        ) : (
          <MapContainer
            center={positions[0] ?? FALLBACK_CENTER}
            zoom={14}
            style={{ height: 480, borderRadius: 8 }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FitBounds positions={positions} />
            {/* The travelled path, highlighted in brand navy */}
            <Polyline positions={positions} pathOptions={{ color: palette.navy, weight: 5, opacity: 0.85 }} />
            {route.points.map((p, i) => (
              <CircleMarker
                key={p.recorded_at}
                center={[p.lat, p.lng]}
                radius={3}
                pathOptions={{ color: palette.navy, fillOpacity: 0.9 }}
              >
                <Tooltip>{`${i + 1}. ${dayjs(p.recorded_at).format("HH:mm:ss")}`}</Tooltip>
              </CircleMarker>
            ))}
            {start && (
              <Marker position={[start.lat, start.lng]} icon={dotIcon(palette.emerald, false)}>
                <Tooltip permanent direction="top" offset={[0, -10]}>
                  Start {dayjs(start.recorded_at).format("HH:mm")}
                </Tooltip>
              </Marker>
            )}
            {end && end !== start && (
              <Marker position={[end.lat, end.lng]} icon={dotIcon(palette.destructive, false)}>
                <Tooltip permanent direction="top" offset={[0, -10]}>
                  End {dayjs(end.recorded_at).format("HH:mm")}
                </Tooltip>
              </Marker>
            )}
          </MapContainer>
        ))}
    </Space>
  );
}

export default function TrackingPage() {
  return (
    <Card title="Team Tracking">
      <Tabs
        items={[
          { key: "live", label: "Live Map", children: <LiveMap /> },
          { key: "replay", label: "Route Replay", children: <RouteReplay /> },
        ]}
      />
    </Card>
  );
}
