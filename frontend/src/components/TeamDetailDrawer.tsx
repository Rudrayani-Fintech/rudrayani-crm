import { Drawer } from "antd";
import BreakdownTable from "./dashboard/BreakdownTable";

/**
 * Team drill-down: reuses BreakdownTable (also powers the branch drawer's
 * "Agent-wise Breakdown") scoped to this team and defaulted to the agent
 * dimension -- no bespoke roster fetch, the breakdown rows already are the
 * roster with live performance attached. Used when a branch_manager/ops/
 * admin clicks into a team from OrgChartPage.
 *
 * KNOWN BROKEN since Phase 7: BreakdownTable itself calls the deleted
 * GET /reports/breakdown. Phase 15 explicitly keeps BreakdownTable in place
 * (OrgChartPage still needs it) without fixing this -- see
 * docs/KNOWN-ISSUES.md §2.
 */
export default function TeamDetailDrawer({
  teamId,
  teamName,
  month,
  open,
  onClose,
}: {
  teamId: string | null;
  teamName?: string;
  month: string; // YYYY-MM
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer title={teamName ?? "Team"} open={open} onClose={onClose} width={760} destroyOnHidden>
      {teamId && <BreakdownTable filters={{ month, team_id: teamId }} defaultDimension="agent" />}
    </Drawer>
  );
}
