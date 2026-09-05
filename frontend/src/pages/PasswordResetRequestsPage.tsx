import { Alert, Badge, Button, Select, Space, Table, Tag, Typography, message } from "antd";
import { KeyOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { palette } from "../theme/tokens";

dayjs.extend(relativeTime);

type ResetStatus = "pending" | "resolved" | "rejected";

interface PasswordResetRequest {
  id: string;
  message: string;
  status: ResetStatus;
  created_at: string;
  resolved_at: string | null;
  user_id: string;
  full_name: string;
  phone: string;
  resolved_by_name: string | null;
}

const STATUS_TAG: Record<ResetStatus, { color: string; label: string }> = {
  pending: { color: "gold", label: "Pending" },
  resolved: { color: "green", label: "Resolved" },
  // The backend accepts this as a GET filter value but has no endpoint that
  // ever produces it (only POST /:id/resolve exists) -- kept here so the
  // filter dropdown matches what the API actually declares, not to imply
  // it's reachable today. See docs/KNOWN-ISSUES.md.
  rejected: { color: "red", label: "Rejected" },
};

/**
 * Phase 16 (A4): the admin-facing queue for the mobile "forgot password"
 * flow (POST /auth/password-reset-request, unauthenticated -- see
 * ForgotPasswordPage.tsx's web counterpart). Branch-scoped server-side
 * (GET /password-reset-requests already clamps via agentBranchClamp, Phase
 * 2) -- a branch_manager sees only their own branch's requests here, same
 * as everywhere else in the portal.
 */
export default function PasswordResetRequestsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ResetStatus>("pending");
  const [requests, setRequests] = useState<PasswordResetRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/password-reset-requests", { params: { status } });
      const rows: PasswordResetRequest[] = res.data.password_reset_requests;
      setRequests(rows);
      if (status === "pending") setPendingCount(rows.length);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  // Same "skip the extra request while already viewing pending" reasoning
  // as CorrectionRequestsPage.tsx's own pendingCount effect.
  useEffect(() => {
    if (status === "pending") return;
    api
      .get("/password-reset-requests", { params: { status: "pending" } })
      .then((res) => setPendingCount(res.data.password_reset_requests.length))
      .catch((err) => message.error(errorMessage(err)));
  }, [status, requests]);

  const resolve = async (id: string) => {
    setResolvingId(id);
    try {
      await api.post(`/password-reset-requests/${id}/resolve`);
      message.success("Marked resolved");
      void load();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div>
      <Typography.Title level={4}>
        Password Reset Requests{" "}
        <Badge count={pendingCount} showZero={false} style={{ backgroundColor: palette.warning }} />
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        A locked-out agent submits this from the mobile login screen. Reset their password from the
        Employees page, then mark the request resolved here.
      </Typography.Paragraph>

      <Space style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 160 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: "pending", label: "Pending" },
            { value: "resolved", label: "Resolved" },
            { value: "rejected", label: "Rejected" },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          Refresh
        </Button>
      </Space>

      <Table<PasswordResetRequest>
        rowKey="id"
        loading={loading}
        dataSource={requests}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "Agent", dataIndex: "full_name", width: 180, ellipsis: true },
          { title: "Phone", dataIndex: "phone", width: 130 },
          { title: "Message", dataIndex: "message", ellipsis: true },
          { title: "Requested", width: 110, render: (_, r) => dayjs(r.created_at).fromNow() },
          {
            title: "Status",
            width: 110,
            render: (_, r) => <Tag color={STATUS_TAG[r.status].color}>{STATUS_TAG[r.status].label}</Tag>,
          },
          ...(status !== "pending"
            ? [
                {
                  title: "Resolved",
                  width: 170,
                  render: (_: unknown, r: PasswordResetRequest) =>
                    r.resolved_at ? `${dayjs(r.resolved_at).fromNow()} by ${r.resolved_by_name ?? "-"}` : "-",
                },
              ]
            : []),
          {
            title: "Actions",
            width: 260,
            render: (_, r) =>
              r.status === "pending" ? (
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    icon={<KeyOutlined />}
                    onClick={() => navigate(`/employees?reset_user_id=${r.user_id}`)}
                  >
                    Reset Password
                  </Button>
                  <Button size="small" loading={resolvingId === r.id} onClick={() => void resolve(r.id)}>
                    Mark Resolved
                  </Button>
                </Space>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
        ]}
      />

      {requests.length === 0 && !loading && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message={status === "pending" ? "No pending password reset requests." : `No ${status} requests.`}
        />
      )}
    </div>
  );
}
