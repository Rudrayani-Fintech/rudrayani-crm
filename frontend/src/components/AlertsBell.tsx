import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Divider, Empty, List, Popover, Tag, Typography, notification } from "antd";
import { BellOutlined, EnvironmentOutlined, KeyOutlined, WarningOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { subscribeLiveTracking, type LiveTrackingData, type TrackingAlert } from "../api/liveTracking";
import { subscribePasswordResetAlerts, type PendingResetRequest } from "../api/passwordResetAlerts";
import { useAuth } from "../auth/AuthContext";
import { palette } from "../theme/tokens";

dayjs.extend(relativeTime);

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
 * pop a toast once. Phase 16 (A4) adds a second source, pending
 * password-reset requests (/password-reset-requests?status=pending) --
 * gated on employees.view independently of tracking.view, so an ops
 * manager with one permission but not the other still sees whichever
 * section applies to them. Renders nothing for a user with neither.
 */
export default function AlertsBell() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<TrackingAlert[]>([]);
  const [resetRequests, setResetRequests] = useState<PendingResetRequest[]>([]);
  const [open, setOpen] = useState(false);
  const [toastApi, toastHolder] = notification.useNotification();
  const seen = useRef(new Set<string>());
  const canView = hasPermission("tracking.view");
  const canViewResets = hasPermission("employees.view");

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

  useEffect(() => {
    if (!canViewResets) return;
    return subscribePasswordResetAlerts((data, err) => {
      if (err || !data) return; // header polling failures stay silent, same as tracking alerts above
      setResetRequests(data);
    });
  }, [canViewResets]);

  if (!canView && !canViewResets) return null;

  const totalCount = alerts.length + resetRequests.length;

  const content = (
    <div style={{ width: 340 }}>
      {canView && (
        <>
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
        </>
      )}
      {canView && canViewResets && <Divider style={{ margin: "8px 0" }} />}
      {canViewResets && (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Password reset requests
          </Typography.Text>
          {resetRequests.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="None pending" />
          ) : (
            <List
              size="small"
              dataSource={resetRequests}
              renderItem={(r) => (
                <List.Item
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    setOpen(false);
                    navigate("/password-reset-requests");
                  }}
                >
                  <List.Item.Meta
                    avatar={<KeyOutlined style={{ fontSize: 18, color: palette.warning }} />}
                    title={r.full_name}
                    description={`${r.phone} · ${dayjs(r.created_at).fromNow()}`}
                  />
                </List.Item>
              )}
            />
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      {toastHolder}
      <Popover
        content={content}
        title="Alerts"
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="bottomRight"
      >
        <Badge count={totalCount} size="small">
          <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} />
        </Badge>
      </Popover>
    </>
  );
}
