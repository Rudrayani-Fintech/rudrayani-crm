import { Button, Card, Progress, Space, Typography } from "antd";
import { CheckCircleFilled, CloseOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { palette } from "../../theme/tokens";

interface SetupSteps {
  company_added: boolean;
  branch_added: boolean;
  employee_added: boolean;
  first_import: boolean;
  allocated: boolean;
  targets_set: boolean;
}

const STEPS: { key: keyof SetupSteps; label: string; to: string }[] = [
  { key: "company_added", label: "Add your first company", to: "/companies" },
  { key: "branch_added", label: "Add branches", to: "/branches" },
  { key: "employee_added", label: "Add employees", to: "/employees" },
  { key: "first_import", label: "Import your first customer file", to: "/import" },
  { key: "allocated", label: "Allocate customers to agents", to: "/allocation" },
  { key: "targets_set", label: "Set collection targets", to: "/targets" },
];

function dismissedKey(agencyId: string) {
  return `rcrm_setup_checklist_dismissed_${agencyId}`;
}

/**
 * A brand-new agency previously landed on a dashboard full of zeros and
 * dashes with no checklist, no sample data, no "add your first company"
 * CTA anywhere -- nothing told a first-time admin what to do next. Each
 * step's done/not-done comes from GET /setup-status (real EXISTS checks,
 * not client-side guessing), so this can't drift out of sync or keep
 * nagging about something that's already done.
 */
export default function SetupChecklist() {
  const { user } = useAuth();
  const [steps, setSteps] = useState<SetupSteps | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (localStorage.getItem(dismissedKey(user.agency_id)) === "true") {
      setDismissed(true);
      return;
    }
    api
      .get("/setup-status")
      .then((res) => setSteps(res.data.steps))
      .catch(() => {
        // Not critical enough to surface an error for -- worst case the
        // checklist just doesn't appear this load.
      });
  }, [user]);

  if (dismissed || !steps) return null;

  const doneCount = STEPS.filter((s) => steps[s.key]).length;
  if (doneCount === STEPS.length) return null; // fully done -- nothing left to nudge about

  const dismiss = () => {
    if (user) localStorage.setItem(dismissedKey(user.agency_id), "true");
    setDismissed(true);
  };

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title="Get set up"
      extra={<Button type="text" size="small" icon={<CloseOutlined />} onClick={dismiss} aria-label="Dismiss" />}
    >
      <Progress percent={Math.round((doneCount / STEPS.length) * 100)} showInfo={false} style={{ marginBottom: 12 }} />
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        {STEPS.map((s) => {
          const done = steps[s.key];
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CheckCircleFilled style={{ color: done ? palette.emerald : palette.border, fontSize: 16 }} />
              {done ? (
                <Typography.Text delete type="secondary">
                  {s.label}
                </Typography.Text>
              ) : (
                <Link to={s.to}>{s.label}</Link>
              )}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}
