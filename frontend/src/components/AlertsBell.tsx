import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Empty, List, Popover, Tag, notification } from "antd";
import { BellOutlined, EnvironmentOutlined, WarningOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { subscribeLiveTracking, type LiveTrackingData, type TrackingAlert } from "../api/liveTracking";
import { useAuth } from "../auth/AuthContext";
import { palette } from "../theme/tokens";

export type { TrackingAlert };

export function alertText(a: TrackingAlert): string {
  return a.status === "stationary"
    ? `At one location for ${a.stationary_minutes} min`
    : `Stopped reporting — last ping ${
        a.last_ping_at ? dayjs(a.last_ping_at).format("HH:mm") : "never"
      }`;
}

/**
 * Header bell: polls /tracking/live so stationary / no-signal alerts follow
 * the manager to every screen, not just the Tracking page. New alerts also
 * pop a toast once. Renders nothing for users without tracking.view.
 */
export default function AlertsBell() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<TrackingAlert[]>([]);
  const [open, setOpen] = useState(false);
  const [toastApi, toastHolder] = notification.useNotification();
  const seen = useRef(new Set<string>());
  const canView = hasPermission("tracking.view");

  const onData = useCallback(
    (data: LiveTrackingData | null, err: unknown) => {
      if (err || !data) return; // header polling failures stay silent -- the Tracking page surfaces errors
      const fresh = data.alerts;
      setAlerts(fresh);
      for (const a of fresh) {
        const key = `${a.user_id}:${a.status}`;
        if (!seen.current.has(key)) {
          seen.current.add(key);
          toastApi.warning({
            key,
            message: a.full_name,
            description: alertText(a),
            icon: <WarningOutlined style={{ color: a.status === "stationary" ? palette.destructive : palette.warning }} />,
            btn: (
              <Button size="small" type="primary" onClick={() => navigate("/tracking")}>
                Open live map
              </Button>
            ),
            duration: 8,
          });
        }
      }
      // An agent that starts moving again can re-alert later.
      const freshKeys = new Set(fresh.map((a) => `${a.user_id}:${a.status}`));
      for (const key of seen.current) {
        if (!freshKeys.has(key)) seen.current.delete(key);
      }
    },
    [navigate, toastApi],
  );

  useEffect(() => {
    if (!canView) return;
    return subscribeLiveTracking(onData);
  }, [canView, onData]);

  if (!canView) return null;

  const content = (
    <div style={{ width: 340 }}>
      {alerts.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tracking alerts" />
      ) : (
        <List
          size="small"
          dataSource={alerts}
          renderItem={(a) => (
            <List.Item
              style={{ cursor: "pointer" }}
              onClick={() => {
                setOpen(false);
                navigate("/tracking");
              }}
            >
              <List.Item.Meta
                avatar={
                  <EnvironmentOutlined
                    style={{ fontSize: 18, color: a.status === "stationary" ? palette.destructive : palette.warning }}
                  />
                }
                title={
                  <>
                    {a.full_name}{" "}
                    <Tag color={a.status === "stationary" ? "red" : "orange"}>
                      {a.status === "stationary" ? "Stationary" : "No signal"}
                    </Tag>
                  </>
                }
                description={`${alertText(a)}${a.team_name ? ` · ${a.team_name}` : ""}`}
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );

  return (
    <>
      {toastHolder}
      <Popover
        content={content}
        title="Tracking alerts"
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="bottomRight"
      >
        <Badge count={alerts.length} size="small">
          <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} />
        </Badge>
      </Popover>
    </>
  );
}
