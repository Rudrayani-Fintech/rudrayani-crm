// Phase 12 (§5.1: "Branch (branch managers only)"), replacing Phase 9's
// home_shell_dashboard_role_test.dart now that the role-specific KPI
// dashboards and My Performance are gone. isBranchManager() is a pure
// function precisely so tab presence can be tested here without mounting
// the full HomeShell widget tree -- Today/My Day/Branch all pull in Dio/Hive/
// connectivity platform channels that aren't mocked anywhere in this suite.
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/features/home/home_shell.dart';

void main() {
  group('isBranchManager (home_shell.dart Branch-tab gate)', () {
    test('a plain field agent does not get the Branch tab', () {
      expect(isBranchManager(['field_agent']), isFalse);
    });

    test('a plain telecaller does not get the Branch tab', () {
      expect(isBranchManager(['telecaller']), isFalse);
    });

    test('a branch manager gets the Branch tab', () {
      expect(isBranchManager(['branch_manager']), isTrue);
    });

    test('a branch manager who also carries collections work still gets it', () {
      expect(isBranchManager(['branch_manager', 'field_agent']), isTrue);
    });

    test('agency_admin/operations_manager alone do NOT get the Branch tab -- §5.1 says branch managers only', () {
      expect(isBranchManager(['agency_admin']), isFalse);
      expect(isBranchManager(['operations_manager']), isFalse);
    });

    test('no capabilities at all gets no Branch tab', () {
      expect(isBranchManager([]), isFalse);
    });
  });
}
