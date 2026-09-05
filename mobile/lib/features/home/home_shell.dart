import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/sync_banner.dart';
import '../dashboard/branch_manager_dashboard_screen.dart';
import '../dashboard/field_executive_dashboard_screen.dart';
import '../dashboard/telecaller_dashboard_screen.dart';
import '../performance/performance_screen.dart';
import '../today/today_screen.dart';
import '../account/account_screen.dart';
import 'duty_bar_host.dart';

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
/// (agent_type set) still gets their own personal Today tab "for free" --
/// TodayScreen is unconditionally present in HomeShell's tab list below
/// regardless of role, so there's no separate dual-capability branch
/// needed here; only the management-tier dashboard tab is role-exclusive.
/// Extracted as a pure function (rather than inlined in build()) so the
/// branching itself has a fast, deterministic unit test independent of the
/// full widget tree (see test/home_shell_dashboard_role_test.dart) --
/// HomeShell's other tabs (TodayScreen in particular) pull in Hive/
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

/// Named tab identity (§7.5) -- replaces a bare `int` index into a
/// conditionally-built list, which broke down as soon as that list's
/// membership could change (it always could: the dashboard tab is
/// role-conditional). `dashboard` covers whichever ONE of the three
/// role-specific dashboards is present -- the role checks are mutually
/// exclusive, so there's never ambiguity about which screen it means for a
/// given user.
enum HomeTab { today, dashboard, performance, account }

class _HomeTabEntry {
  final HomeTab tab;
  final NavigationDestination destination;
  final WidgetBuilder builder;
  const _HomeTabEntry({required this.tab, required this.destination, required this.builder});
}

/// Role-aware landing (brief §3, §10; Phase 12: role-based dashboards).
/// Every role gets Today / My Performance; a branch_manager
/// additionally gets a Branch Dashboard (covering every team in their
/// branch directly, plus reallocation approvals), and a plain telecaller/
/// field_agent gets their own role-specific Dashboard tab.
class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  HomeTab _tab = HomeTab.today;

  @override
  Widget build(BuildContext context) {
    final capabilities = ref.watch(authProvider.select((s) => s.capabilities));
    final role = resolveDashboardRole(capabilities);
    final isBranchManager = role == DashboardRole.branchManager;
    final isTelecaller = role == DashboardRole.telecaller;
    final isFieldAgent = role == DashboardRole.fieldAgent;

    final entries = <_HomeTabEntry>[
      _HomeTabEntry(
        tab: HomeTab.today,
        destination: const NavigationDestination(
          icon: Icon(Icons.today),
          label: 'Today',
        ),
        builder: (_) => const TodayScreen(),
      ),
      if (isBranchManager)
        _HomeTabEntry(
          tab: HomeTab.dashboard,
          destination: const NavigationDestination(
            icon: Icon(Icons.apartment),
            label: 'Branch Dashboard',
          ),
          builder: (_) => const BranchManagerDashboardScreen(),
        ),
      if (isTelecaller)
        _HomeTabEntry(
          tab: HomeTab.dashboard,
          destination: const NavigationDestination(
            icon: Icon(Icons.dashboard),
            label: 'Dashboard',
          ),
          builder: (_) => const TelecallerDashboardScreen(),
        ),
      if (isFieldAgent)
        _HomeTabEntry(
          tab: HomeTab.dashboard,
          destination: const NavigationDestination(
            icon: Icon(Icons.dashboard),
            label: 'Dashboard',
          ),
          builder: (_) => const FieldExecutiveDashboardScreen(),
        ),
      _HomeTabEntry(
        tab: HomeTab.performance,
        destination: const NavigationDestination(
          icon: Icon(Icons.insights),
          label: 'My Performance',
        ),
        builder: (_) => const PerformanceScreen(),
      ),
      _HomeTabEntry(
        tab: HomeTab.account,
        destination: const NavigationDestination(
          icon: Icon(Icons.person),
          label: 'Account',
        ),
        builder: (_) => const AccountScreen(),
      ),
    ];

    final activeIndex = entries.indexWhere((e) => e.tab == _tab);
    final active = activeIndex >= 0 ? entries[activeIndex] : entries.first;

    return Scaffold(
      body: Column(
        children: [
          // Phase 10 (§5.1, S7): persistent duty bar above every tab -- the
          // quick-glance duty/timer/sync/offline indicator. SyncBanner stays
          // underneath for the actionable detail view (pending list,
          // dead-letter discard, error dismiss) that the duty bar's compact
          // sync count doesn't attempt to duplicate.
          const DutyBarHost(),
          const SyncBanner(),
          // Phase 9 (§7.4): previously an IndexedStack built every tab's
          // screen at once -- the documented cause of a 6-8 parallel-request
          // burst at login (every tab's providers fired immediately, even
          // for tabs the agent never opened). Only the selected tab's
          // screen is built now; switching tabs rebuilds fresh each time
          // (no scroll-position retention across tabs -- an accepted
          // trade-off for the fix, not itself part of this phase's brief).
          Expanded(child: active.builder(context)),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: activeIndex >= 0 ? activeIndex : 0,
        onDestinationSelected: (i) => setState(() => _tab = entries[i].tab),
        indicatorColor: AppColors.primary.withValues(alpha: 0.15),
        destinations: [for (final e in entries) e.destination],
      ),
    );
  }
}
