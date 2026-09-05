// Phase 12 (role-based dashboards) + Phase 2 (team_leader removed).
// home_shell.dart picks exactly one of the dashboard tabs (Branch Manager /
// Telecaller / Field Executive) based on the signed-in user's capabilities,
// with branch_manager taking precedence over telecaller over field_agent if
// more than one flag is somehow set; agency_admin/operations_manager fall
// back to the branch_manager tab too (agency-wide scope resolves the same
// way server-side). The branching itself is a pure function
// (resolveDashboardRole) precisely so it can be tested here without mounting
// the full HomeShell widget tree -- TodayScreen (one of the other tabs)
// pulls in Hive/connectivity_plus platform channels that aren't mocked
// anywhere in this test suite, so a full-tree HomeShell widget test isn't
// practical; the per-screen rendering tests (telecaller_dashboard_test.dart
// etc.) cover the new screens themselves in isolation instead.
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/features/home/home_shell.dart';

void main() {
  group('resolveDashboardRole (home_shell.dart routing)', () {
    test('branch_manager routes to the Branch Manager dashboard', () {
      expect(resolveDashboardRole(['branch_manager']), DashboardRole.branchManager);
    });

    test('telecaller routes to the Telecaller dashboard', () {
      expect(resolveDashboardRole(['telecaller']), DashboardRole.telecaller);
    });

    test('field_agent routes to the Field Executive dashboard', () {
      expect(resolveDashboardRole(['field_agent']), DashboardRole.fieldAgent);
    });

    test('agency_admin / operations_manager fall back to the Branch Manager dashboard', () {
      expect(resolveDashboardRole(['agency_admin']), DashboardRole.branchManager);
      expect(resolveDashboardRole(['operations_manager']), DashboardRole.branchManager);
    });

    test('no recognized capability gets no role dashboard tab', () {
      expect(resolveDashboardRole([]), isNull);
    });

    test('branch_manager takes precedence over telecaller and field_agent', () {
      expect(
        resolveDashboardRole(['branch_manager', 'telecaller', 'field_agent']),
        DashboardRole.branchManager,
      );
    });

    test('telecaller takes precedence over field_agent', () {
      expect(resolveDashboardRole(['telecaller', 'field_agent']), DashboardRole.telecaller);
    });
  });
}
