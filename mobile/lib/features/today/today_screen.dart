import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/models/account.dart';
import '../../core/offline/worklist_filter_store.dart';
import '../../core/theme/app_theme.dart';
import '../../core/tracking/tracking_service.dart';
import '../../core/ui/ui.dart';
import '../../core/utils/friendly_error.dart';
import '../reminders/today_section.dart';
import '../worklist/worklist_provider.dart';
import 'today_provider.dart';

/// Exact once the first worked-today row has loaded onto the page -- the
/// backend sorts worked rows strictly after unworked ones globally (§4.1:
/// `ORDER BY (worked_today) ASC, ...`), so everything from that row onward
/// (`total - boundaryIndex`) is worked regardless of how many further pages
/// remain unfetched. Returns null before that boundary appears (unless
/// every row has already loaded, in which case zero worked rows is itself
/// the answer) -- the UI shows just the total until then rather than an
/// undercount masquerading as the real figure.
int? workedCountFromLoaded(List<Account> items, int total) {
  final boundary = items.indexWhere((a) => a.workedToday == true);
  if (boundary == -1) return items.length >= total ? 0 : null;
  return total - boundary;
}

/// Sum of `collected_today` across whatever's loaded so far. Exact once
/// every worked row has loaded (see [workedCountFromLoaded]); an
/// undercount-in-progress otherwise, same caveat as the worked count.
double collectedTodaySoFar(List<Account> items) =>
    items.fold(0.0, (sum, a) => sum + (a.collectedToday ?? 0));

/// Phase 10 (§5.1, P7, P8): the field-agent home screen -- PTPs due
/// (collapsible, highlighted) above a lazily-paginated, server-searched and
/// server-filtered assigned list, worked rows greyed and sunk to the
/// bottom. Replaces WorklistScreen as the Today tab's content.
class TodayScreen extends ConsumerStatefulWidget {
  const TodayScreen({super.key});

  @override
  ConsumerState<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends ConsumerState<TodayScreen> {
  final _searchCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  Timer? _debounce;

  // Same branch/bucket-filter hydration gate WorklistScreen used (see its
  // comment for the full race explanation) -- carried over unchanged since
  // the underlying auth-vs-attendance startup race is unrelated to this
  // phase.
  bool _filtersHydrated = false;
  String? _hydratingForUserId;
  Timer? _hydrationTimeoutTimer;

  @override
  void initState() {
    super.initState();
    _scrollCtrl.addListener(_onScroll);
    final userId = ref.read(authProvider).user?['id'] as String?;
    if (userId != null) _hydrateFilters(userId);
    _hydrationTimeoutTimer = Timer(const Duration(seconds: 3), () {
      if (mounted && !_filtersHydrated) setState(() => _filtersHydrated = true);
    });
  }

  void _hydrateFilters(String userId) {
    if (_hydratingForUserId == userId) return;
    _hydratingForUserId = userId;
    WorklistFilterStore.load(userId).then((selection) {
      if (!mounted) return;
      ref.read(worklistFiltersProvider.notifier).state = selection;
      _hydrationTimeoutTimer?.cancel();
      setState(() => _filtersHydrated = true);
    });
  }

  void _updateFilters(WorklistFilterSelection selection) {
    ref.read(worklistFiltersProvider.notifier).state = selection;
    final userId = ref.read(authProvider).user?['id'] as String?;
    if (userId != null) WorklistFilterStore.save(userId, selection);
  }

  void _onScroll() {
    if (!_scrollCtrl.hasClients) return;
    if (_scrollCtrl.position.pixels > _scrollCtrl.position.maxScrollExtent - 400) {
      ref.read(todayWorklistProvider.notifier).loadMore();
    }
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) ref.read(todaySearchQueryProvider.notifier).state = value.trim();
    });
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _scrollCtrl.dispose();
    _debounce?.cancel();
    _hydrationTimeoutTimer?.cancel();
    super.dispose();
  }

  Future<void> _confirmLogout(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Log out?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Log out')),
        ],
      ),
    );
    if (ok == true && mounted) {
      await TrackingService.stop();
      await ref.read(authProvider.notifier).logout();
      // ignore: use_build_context_synchronously
      if (mounted) context.go('/login');
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AuthState>(authProvider, (prev, next) {
      final userId = next.user?['id'] as String?;
      if (userId != null) _hydrateFilters(userId);
    });

    if (!_filtersHydrated) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final auth = ref.watch(authProvider);
    final state = ref.watch(todayWorklistProvider);
    final userName = auth.user?['full_name'] ?? 'Agent';
    final isBranchManager = auth.capabilities.contains('branch_manager');
    final scope = ref.watch(worklistScopeProvider);
    final filters = ref.watch(worklistFiltersProvider);
    final options = ref.watch(worklistFilterOptionsProvider);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Today', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            Text(userName, style: TextStyle(fontSize: 14, color: AppColors.onPrimary.withValues(alpha: 0.7))),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.read(todayWorklistProvider.notifier).refresh(),
          ),
          IconButton(icon: const Icon(Icons.logout), onPressed: () => _confirmLogout(context)),
        ],
      ),
      body: Column(
        children: [
          if (ref.watch(worklistIsStaleProvider))
            Container(
              width: double.infinity,
              color: AppColors.warningContainer,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: const Text(
                'Offline — showing your last saved worklist',
                style: TextStyle(fontSize: 14, color: AppColors.warningStrong),
                textAlign: TextAlign.center,
              ),
            ),
          if (isBranchManager)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
              child: SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'personal', label: Text('Personal')),
                  ButtonSegment(value: 'team', label: Text('Team')),
                ],
                selected: {scope},
                onSelectionChanged: (s) => ref.read(worklistScopeProvider.notifier).state = s.first,
              ),
            ),
          // PTP Follow-ups (§5.1): TodaySection already builds a collapsible,
          // count-badged strip with the stronger accent this section needs
          // (heroMode) -- built in Phase 8 but never given a real call site
          // until now (X6).
          const TodaySection(heroMode: true),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
            child: Column(
              children: [
                TextField(
                  controller: _searchCtrl,
                  decoration: InputDecoration(
                    hintText: 'Search by name, loan number or mobile…',
                    prefixIcon: const Icon(Icons.search),
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
                    contentPadding: const EdgeInsets.symmetric(vertical: 0, horizontal: 12),
                  ),
                  onChanged: _onSearchChanged,
                ),
                const SizedBox(height: AppSpacing.sm),
                options.when(
                  data: (opts) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // P6: customer branch is the primary filter.
                      if (opts.branches.isNotEmpty)
                        AppChipGroup<String>(
                          multiSelect: true,
                          options: [for (final b in opts.branches) AppChipOption(value: b, label: b)],
                          selected: filters.branches.toSet(),
                          onSelected: (b) {
                            final next = List<String>.from(filters.branches);
                            next.contains(b) ? next.remove(b) : next.add(b);
                            _updateFilters(WorklistFilterSelection(branches: next, buckets: filters.buckets));
                          },
                        ),
                      if (opts.buckets.isNotEmpty) ...[
                        const SizedBox(height: AppSpacing.xs),
                        AppChipGroup<String>(
                          multiSelect: true,
                          options: [for (final b in opts.buckets) AppChipOption(value: b, label: b)],
                          selected: filters.buckets.toSet(),
                          onSelected: (b) {
                            final next = List<String>.from(filters.buckets);
                            next.contains(b) ? next.remove(b) : next.add(b);
                            _updateFilters(WorklistFilterSelection(branches: filters.branches, buckets: next));
                          },
                        ),
                      ],
                    ],
                  ),
                  loading: () => const SizedBox.shrink(),
                  error: (_, _) => const SizedBox.shrink(),
                ),
              ],
            ),
          ),
          Expanded(child: _buildList(state, filters)),
        ],
      ),
    );
  }

  Widget _buildList(TodayWorklistState state, WorklistFilterSelection filters) {
    if (state.loading) return const Center(child: CircularProgressIndicator());
    if (state.error != null) {
      return AppErrorState(
        message: 'Could not load your worklist.\n${friendlyError(state.error!)}',
        onRetry: () => ref.read(todayWorklistProvider.notifier).refresh(),
      );
    }
    if (state.items.isEmpty) {
      final hasFilter = filters.branches.isNotEmpty || filters.buckets.isNotEmpty;
      return AppEmptyState(
        icon: Icons.people_outline,
        message: 'No customers assigned today.',
        hint: 'Pull down to refresh once new accounts land.',
        action: hasFilter
            ? TextButton(
                onPressed: () => _updateFilters(const WorklistFilterSelection()),
                child: const Text('Clear filters'),
              )
            : null,
      );
    }

    final workedCount = workedCountFromLoaded(state.items, state.total);
    return RefreshIndicator(
      onRefresh: () => ref.read(todayWorklistProvider.notifier).refresh(),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    workedCount != null
                        ? '$workedCount of ${state.total} worked · '
                        : '${state.total} assigned · ',
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(color: AppColors.textSecondary),
                  ),
                ),
                AppMoney(
                  collectedTodaySoFar(state.items),
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: AppColors.successStrong,
                        fontWeight: FontWeight.w600,
                      ),
                ),
                Text(
                  ' collected',
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView.builder(
              controller: _scrollCtrl,
              itemCount: state.items.length + (state.hasMore ? 1 : 0),
              itemBuilder: (ctx, i) {
                if (i >= state.items.length) {
                  return const Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                return _TodayRow(account: state.items[i]);
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _TodayRow extends StatelessWidget {
  final Account account;
  const _TodayRow({required this.account});

  Future<void> _dial(BuildContext context) async {
    final uri = Uri(scheme: 'tel', path: account.mobileNumber);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Cannot open dialer')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final worked = account.workedToday == true;
    final hasPtp = account.ptpDate != null;
    final today = DateTime.now();
    final todayDateOnly = DateTime(today.year, today.month, today.day);
    final ptpDue = hasPtp && account.ptpDate!.isBefore(todayDateOnly.add(const Duration(days: 1)));

    // P8: worked rows grey out -- muted text/icon colours throughout, not a
    // literal Opacity() wrap (which would also fade the tap ripple).
    final titleColor = worked ? AppColors.textSecondary : null;
    final subtitleColor = worked ? AppColors.textTertiary : AppColors.textSecondary;

    return AppListRow(
      onTap: () => context.push('/customer/${account.id}'),
      leading: CircleAvatar(
        backgroundColor: worked
            ? AppColors.neutralContainer
            : (ptpDue ? AppColors.warning : AppColors.primary),
        child: Icon(
          worked ? Icons.check : (ptpDue ? Icons.schedule : Icons.person),
          color: worked ? AppColors.textSecondary : AppColors.onPrimary,
          size: 20,
        ),
      ),
      title: Text(
        account.customerName,
        style: TextStyle(fontWeight: FontWeight.bold, color: titleColor),
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${account.loanNumber} · ${account.companyName}', style: TextStyle(color: subtitleColor)),
          if (account.dueAmount != null)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Due: ', style: TextStyle(color: subtitleColor)),
                AppMoney(account.dueAmount, style: TextStyle(color: subtitleColor, fontWeight: FontWeight.w600)),
              ],
            ),
          if (hasPtp)
            Text(
              'PTP due ${ptpDue ? "today" : "later"}',
              style: TextStyle(color: worked ? subtitleColor : (ptpDue ? AppColors.warningStrong : AppColors.successStrong)),
            ),
          if (worked)
            Text(
              account.lastCallAt != null && account.lastCallAt!.toLocal().day == today.day
                  ? 'Worked ✓ ${_time(account.lastCallAt!)}'
                  : 'Worked ✓',
              style: const TextStyle(color: AppColors.textTertiary),
            ),
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (account.mobileNumber.isNotEmpty)
            IconButton(
              icon: Icon(Icons.call, color: worked ? AppColors.textTertiary : AppColors.success),
              tooltip: 'Call',
              onPressed: () => _dial(context),
            ),
          Icon(Icons.chevron_right, color: worked ? AppColors.textTertiary : null),
        ],
      ),
    );
  }

  String _time(DateTime dt) {
    final local = dt.toLocal();
    final h = local.hour.toString().padLeft(2, '0');
    final m = local.minute.toString().padLeft(2, '0');
    return '$h:$m';
  }
}
