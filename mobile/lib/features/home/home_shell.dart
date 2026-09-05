import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/sync_banner.dart';
import '../branch/branch_screen.dart';
import '../myday/myday_screen.dart';
import '../today/today_screen.dart';
import '../account/account_screen.dart';
import 'duty_bar_host.dart';

/// Whether the signed-in user's capability set earns the Branch tab (§5.1:
/// "Branch (branch managers only)"). A plain, literal capability check --
/// unlike Phase 9's `resolveDashboardRole()` (which this replaces), there is
/// no longer a widest-scope-wins fallback for agency_admin/operations_manager:
/// the spec names branch managers specifically, and agency-wide browsing of
/// every branch's agents isn't something this phase asks for. Extracted as a
/// pure function so tab presence has a fast, deterministic unit test
/// independent of the full widget tree (see
/// test/home_shell_tab_presence_test.dart) -- HomeShell's other tabs (Today
/// in particular) pull in Hive/connectivity platform channels that make a
/// full widget-tree mount impractical for a routing-only test.
bool isBranchManager(List<String> capabilities) => capabilities.contains('branch_manager');

/// Named tab identity (§7.5) -- replaces a bare `int` index into a
/// conditionally-built list, which breaks down as soon as that list's
/// membership can change (it always can: the Branch tab is role-conditional).
enum HomeTab { today, myDay, branch, account }

class _HomeTabEntry {
  final HomeTab tab;
  final NavigationDestination destination;
  final WidgetBuilder builder;
  const _HomeTabEntry({required this.tab, required this.destination, required this.builder});
}

/// Field-agent home (§5.1): Today, My Day, Account for everyone; Branch
/// additionally for branch managers. Phase 12 retires the three role-specific
/// KPI dashboards and My Performance -- all four depended on `/reports/dashboard`,
/// deleted in Phase 7, so they had been silently broken (404) since then.
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
    final showBranchTab = isBranchManager(capabilities);

    final entries = <_HomeTabEntry>[
      _HomeTabEntry(
        tab: HomeTab.today,
        destination: const NavigationDestination(icon: Icon(Icons.today), label: 'Today'),
        builder: (_) => const TodayScreen(),
      ),
      _HomeTabEntry(
        tab: HomeTab.myDay,
        destination: const NavigationDestination(icon: Icon(Icons.insights_outlined), label: 'My Day'),
        builder: (_) => const MyDayScreen(),
      ),
      if (showBranchTab)
        _HomeTabEntry(
          tab: HomeTab.branch,
          destination: const NavigationDestination(icon: Icon(Icons.apartment), label: 'Branch'),
          builder: (_) => const BranchScreen(),
        ),
      _HomeTabEntry(
        tab: HomeTab.account,
        destination: const NavigationDestination(icon: Icon(Icons.person), label: 'Account'),
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
          // Phase 9 (§7.4): only the selected tab's screen is built -- an
          // IndexedStack building every tab at once was the documented cause
          // of a 6-8 parallel-request burst at login.
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
