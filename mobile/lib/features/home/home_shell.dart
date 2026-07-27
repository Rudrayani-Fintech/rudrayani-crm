import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/sync_banner.dart';
import '../dashboard/branch_manager_dashboard_screen.dart';
import '../dashboard/field_executive_dashboard_screen.dart';
import '../dashboard/telecaller_dashboard_screen.dart';
import '../performance/performance_screen.dart';
import '../worklist/worklist_screen.dart';
import '../account/account_screen.dart';

/// Which role-specific dashboard tab (if any) a user's capability set maps
/// to. A user can only hold one of branch_manager/telecaller/field_agent as
/// their primary "management/individual work" capability in practice, but
/// if more than one flag is somehow set, branch_manager wins (widest scope)
/// then telecaller then field_agent -- the same precedence scope.ts/
/// resolveReportScope use server-side. Phase 2: team_leader is gone --
/// every team in a branch reports directly to that branch's branch_manager
/// now, no intermediary rank, so admin/operations_manager fall back to the
/// branch_manager dashboard tab too (agency-wide scope resolves the same
/// way server-side). A branch_manager who ALSO carries collections work
/// (agent_type set) still gets their own personal worklist "for free" --
/// WorklistScreen is unconditionally present in HomeShell's screens list
/// below regardless of role, so there's no separate dual-capability branch
/// needed here; only the management-tier dashboard tab is role-exclusive.
/// Extracted as a pure function (rather than inlined in build()) so the
/// branching itself has a fast, deterministic unit test independent of the
/// full widget tree (see test/home_shell_dashboard_role_test.dart) --
/// HomeShell's other tabs (WorklistScreen in particular) pull in Hive/
/// connectivity platform channels that make a full widget-tree mount
/// impractical for a routing-only test.
enum DashboardRole { branchManager, telecaller, fieldAgent }

DashboardRole? resolveDashboardRole(List<String> capabilities) {
  if (capabilities.contains('agency_admin') || capabilities.contains('operations_manager')) {
    return DashboardRole.branchManager;
  }
  if (capabilities.contains('branch_manager')) return DashboardRole.branchManager;
  if (capabilities.contains('telecaller')) return DashboardRole.telecaller;
  if (capabilities.contains('field_agent')) return DashboardRole.fieldAgent;
  return null;
}

/// Role-aware landing (brief §3, §10; Phase 12: role-based dashboards).
/// Every role gets My Worklist / My Performance; a branch_manager
/// additionally gets a Branch Dashboard (covering every team in their
/// branch directly, plus reallocation approvals), and a plain telecaller/
/// field_agent gets their own role-specific Dashboard tab.
class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final capabilities = ref.watch(authProvider.select((s) => s.capabilities));
    final role = resolveDashboardRole(capabilities);
    final isBranchManager = role == DashboardRole.branchManager;
    final isTelecaller = role == DashboardRole.telecaller;
    final isFieldAgent = role == DashboardRole.fieldAgent;

    final screens = [
      const WorklistScreen(),
      if (isBranchManager) const BranchManagerDashboardScreen(),
      if (isTelecaller) const TelecallerDashboardScreen(),
      if (isFieldAgent) const FieldExecutiveDashboardScreen(),
      const PerformanceScreen(),
      const AccountScreen(),
    ];
    final destinations = [
      const NavigationDestination(
        icon: Icon(Icons.list_alt),
        label: 'My Worklist',
      ),
      if (isBranchManager)
        const NavigationDestination(
          icon: Icon(Icons.apartment),
          label: 'Branch Dashboard',
        ),
      if (isTelecaller)
        const NavigationDestination(
          icon: Icon(Icons.dashboard),
          label: 'Dashboard',
        ),
      if (isFieldAgent)
        const NavigationDestination(
          icon: Icon(Icons.dashboard),
          label: 'Dashboard',
        ),
      const NavigationDestination(
        icon: Icon(Icons.insights),
        label: 'My Performance',
      ),
      const NavigationDestination(
        icon: Icon(Icons.person),
        label: 'Account',
      ),
    ];

    return Scaffold(
      body: Column(
        children: [
          const SyncBanner(),
          Expanded(child: IndexedStack(index: _tab, children: screens)),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        indicatorColor: AppColors.primary.withValues(alpha: 0.15),
        destinations: destinations,
      ),
    );
  }
}
