import { Alert, Space } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";

/**
 * A branch manager (or anyone with customers.allocate) previously had zero
 * visibility into pending reallocation/correction requests unless they
 * happened to visit those two queues directly -- nothing on their landing
 * page said "you have approvals waiting." This is the smallest real fix for
 * that: a quiet count with a direct link, not a full separate landing page.
 */
export default function PendingApprovalsAlert() {
  const [reallocationCount, setReallocationCount] = useState(0);
  const [correctionCount, setCorrectionCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get("/reallocation-requests", { params: { status: "pending" } }),
      api.get("/correction-requests", { params: { status: "pending" } }),
    ])
      .then(([r, c]) => {
        if (cancelled) return;
        setReallocationCount(r.data.total ?? 0);
        setCorrectionCount(c.data.total ?? 0);
      })
      .catch(() => {
        // Silent -- this is a supplementary heads-up, not the primary view;
        // the two queue pages themselves surface their own load errors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const total = reallocationCount + correctionCount;
  if (total === 0) return null;

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={
        <Space size={16} wrap>
          <span>
            <b>{total}</b> approval{total === 1 ? "" : "s"} waiting on you
          </span>
          {reallocationCount > 0 && (
            <Link to="/reallocation-requests">{reallocationCount} reallocation request(s)</Link>
          )}
          {correctionCount > 0 && <Link to="/correction-requests">{correctionCount} correction request(s)</Link>}
        </Space>
      }
    />
  );
}
