import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/models/customer.dart';
import '../../core/theme/app_theme.dart';
import '../../core/tracking/tracking_service.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/widgets/state_views.dart';
import 'worklist_provider.dart';
import '../reminders/today_section.dart';

final _rupee = NumberFormat.currency(
  locale: 'en_IN',
  symbol: '₹',
  decimalDigits: 0,
);

class WorklistScreen extends ConsumerStatefulWidget {
  const WorklistScreen({super.key});

  @override
  ConsumerState<WorklistScreen> createState() => _WorklistScreenState();
}

enum _QuickFilter { none, ptpDueToday, overdue, notWorked }

enum _SortOrder { defaultOrder, highestDue, nearestPtp, oldestContact }

class _WorklistScreenState extends ConsumerState<WorklistScreen> {
  String _search = '';
  String? _selectedCompany;
  String? _selectedBucket;
  _QuickFilter _quickFilter = _QuickFilter.none;
  _SortOrder _sort = _SortOrder.defaultOrder;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  // 300ms debounce -- previously every keystroke re-ran `.where()` over the
  // whole loaded list and rebuilt the entire ListView, undebounced.
  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) setState(() => _search = value.toLowerCase());
    });
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);
    final wl = ref.watch(worklistProvider);
    final user = auth.user;
    final userName = user?['full_name'] ?? 'Agent';
    final isBranchManager = auth.capabilities.contains('branch_manager');
    final scope = ref.watch(worklistScopeProvider);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'My Worklist',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            Text(
              userName,
              style: TextStyle(
                fontSize: 12,
                color: AppColors.onPrimary.withValues(alpha: 0.7),
              ),
            ),
          ],
        ),
        actions: [
          PopupMenuButton<_SortOrder>(
            icon: const Icon(Icons.sort),
            tooltip: 'Sort',
            initialValue: _sort,
            onSelected: (v) => setState(() => _sort = v),
            itemBuilder: (ctx) => const [
              PopupMenuItem(value: _SortOrder.defaultOrder, child: Text('Default (next action)')),
              PopupMenuItem(value: _SortOrder.highestDue, child: Text('Highest due first')),
              PopupMenuItem(value: _SortOrder.nearestPtp, child: Text('Nearest PTP first')),
              PopupMenuItem(value: _SortOrder.oldestContact, child: Text('Oldest contact first')),
            ],
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              ref.invalidate(worklistProvider);
              ref.invalidate(dispositionCodesProvider);
            },
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () => _confirmLogout(context),
          ),
        ],
      ),
      body: Column(
        children: [
          // The worklist now falls back to the last cached copy when the
          // network fails -- this makes sure that's visible, rather than
          // letting an agent unknowingly work off possibly-hours-old data
          // without any indication it isn't live.
          if (ref.watch(worklistIsStaleProvider))
            Container(
              width: double.infinity,
              color: AppColors.warningContainer,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: const Text(
                'Offline — showing your last saved worklist',
                style: TextStyle(fontSize: 12, color: AppColors.warningStrong),
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
                onSelectionChanged: (s) {
                  ref.read(worklistScopeProvider.notifier).state = s.first;
                  ref.invalidate(worklistProvider);
                },
              ),
            ),
          const TodaySection(),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              children: [
                TextField(
                  decoration: InputDecoration(
                    hintText: 'Search by name, loan number or mobile…',
                    prefixIcon: const Icon(Icons.search),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                    contentPadding: const EdgeInsets.symmetric(
                      vertical: 0,
                      horizontal: 12,
                    ),
                  ),
                  onChanged: _onSearchChanged,
                ),
                // Track 7.2: Company filter dropdown
                const SizedBox(height: 8),
                wl.maybeWhen(
                  data: (customers) {
                    final companies = customers
                        .map((c) => c.companyName)
                        .toSet()
                        .toList()
                        ..sort();
                    final buckets = customers
                        .map((c) => c.bucket)
                        .whereType<String>()
                        .toSet()
                        .toList()
                        ..sort();
                    return Column(
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: DropdownButton<String?>(
                                isExpanded: true,
                                value: _selectedCompany,
                                hint: const Text('Filter by company'),
                                items: [
                                  const DropdownMenuItem<String?>(
                                    value: null,
                                    child: Text('All companies'),
                                  ),
                                  ...companies.map(
                                    (company) => DropdownMenuItem(
                                      value: company,
                                      child: Text(company),
                                    ),
                                  ),
                                ],
                                onChanged: (value) =>
                                    setState(() => _selectedCompany = value),
                              ),
                            ),
                            if (buckets.isNotEmpty) ...[
                              const SizedBox(width: 12),
                              Expanded(
                                child: DropdownButton<String?>(
                                  isExpanded: true,
                                  value: _selectedBucket,
                                  hint: const Text('Filter by bucket'),
                                  items: [
                                    const DropdownMenuItem<String?>(
                                      value: null,
                                      child: Text('All buckets'),
                                    ),
                                    ...buckets.map(
                                      (bucket) => DropdownMenuItem(
                                        value: bucket,
                                        child: Text(bucket),
                                      ),
                                    ),
                                  ],
                                  onChanged: (value) =>
                                      setState(() => _selectedBucket = value),
                                ),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          children: [
                            ChoiceChip(
                              label: const Text('PTP due today'),
                              selected: _quickFilter == _QuickFilter.ptpDueToday,
                              onSelected: (sel) => setState(
                                () => _quickFilter = sel ? _QuickFilter.ptpDueToday : _QuickFilter.none,
                              ),
                            ),
                            ChoiceChip(
                              label: const Text('Overdue'),
                              selected: _quickFilter == _QuickFilter.overdue,
                              onSelected: (sel) => setState(
                                () => _quickFilter = sel ? _QuickFilter.overdue : _QuickFilter.none,
                              ),
                            ),
                            ChoiceChip(
                              label: const Text('Not yet worked'),
                              selected: _quickFilter == _QuickFilter.notWorked,
                              onSelected: (sel) => setState(
                                () => _quickFilter = sel ? _QuickFilter.notWorked : _QuickFilter.none,
                              ),
                            ),
                          ],
                        ),
                      ],
                    );
                  },
                  orElse: () => const SizedBox.shrink(),
                ),
              ],
            ),
          ),
          Expanded(
            child: wl.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => ErrorState(
                message: 'Could not load your worklist.\n${friendlyError(e)}',
                onRetry: () {
                  ref.invalidate(worklistProvider);
                  ref.invalidate(dispositionCodesProvider);
                },
              ),
              data: (customers) {
                if (customers.isEmpty) {
                  return const EmptyState(
                    icon: Icons.people_outline,
                    message: 'No customers assigned today.',
                    hint: 'Pull down to refresh once new accounts land.',
                  );
                }

                // Track 7.2: Client-side company filter
                var filtered = _selectedCompany != null
                    ? customers
                        .where((c) => c.companyName == _selectedCompany)
                        .toList()
                    : customers;

                if (_selectedBucket != null) {
                  filtered = filtered.where((c) => c.bucket == _selectedBucket).toList();
                }

                final today = DateTime.now();
                final todayDateOnly = DateTime(today.year, today.month, today.day);
                switch (_quickFilter) {
                  case _QuickFilter.ptpDueToday:
                    filtered = filtered
                        .where((c) =>
                            c.ptpDate != null &&
                            !c.ptpDate!.isBefore(todayDateOnly) &&
                            c.ptpDate!.isBefore(todayDateOnly.add(const Duration(days: 1))))
                        .toList();
                    break;
                  case _QuickFilter.overdue:
                    filtered = filtered.where((c) => c.ptpDate != null && c.ptpDate!.isBefore(todayDateOnly)).toList();
                    break;
                  case _QuickFilter.notWorked:
                    filtered = filtered.where((c) => c.lastCallAt == null).toList();
                    break;
                  case _QuickFilter.none:
                    break;
                }

                // Apply search filter
                if (_search.isNotEmpty) {
                  filtered = filtered
                      .where(
                        (c) =>
                            c.customerName.toLowerCase().contains(
                              _search,
                            ) ||
                            c.loanNumber.toLowerCase().contains(_search) ||
                            c.mobileNumber.contains(_search),
                      )
                      .toList();
                }

                switch (_sort) {
                  case _SortOrder.highestDue:
                    filtered = [...filtered]..sort((a, b) => (b.dueAmount ?? 0).compareTo(a.dueAmount ?? 0));
                    break;
                  case _SortOrder.nearestPtp:
                    filtered = [...filtered]..sort((a, b) {
                      if (a.ptpDate == null && b.ptpDate == null) return 0;
                      if (a.ptpDate == null) return 1;
                      if (b.ptpDate == null) return -1;
                      return a.ptpDate!.compareTo(b.ptpDate!);
                    });
                    break;
                  case _SortOrder.oldestContact:
                    filtered = [...filtered]..sort((a, b) {
                      if (a.lastCallAt == null && b.lastCallAt == null) return 0;
                      if (a.lastCallAt == null) return -1;
                      if (b.lastCallAt == null) return 1;
                      return a.lastCallAt!.compareTo(b.lastCallAt!);
                    });
                    break;
                  case _SortOrder.defaultOrder:
                    break;
                }

                if (filtered.isEmpty) {
                  // Distinct from the "nothing assigned at all" case above --
                  // the agent has a worklist, they just mistyped a search or
                  // picked a combination of filters with no matches.
                  return EmptyState(
                    icon: Icons.search_off,
                    message: 'No matches for your search or filters.',
                    hint: 'Try clearing the search box or filters.',
                    action: TextButton(
                      onPressed: () => setState(() {
                        _search = '';
                        _selectedCompany = null;
                        _selectedBucket = null;
                        _quickFilter = _QuickFilter.none;
                      }),
                      child: const Text('Clear all filters'),
                    ),
                  );
                }

                return RefreshIndicator(
                  onRefresh: () async {
                    ref.invalidate(worklistProvider);
                    ref.invalidate(dispositionCodesProvider);
                  },
                  child: ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    itemCount: filtered.length,
                    itemBuilder: (ctx, i) =>
                        _CustomerCard(customer: filtered[i]),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmLogout(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Log out?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Log out'),
          ),
        ],
      ),
    );
    if (ok == true && mounted) {
      // Shift stays open server-side, but the service must not outlive the
      // session's tokens — punch out properly to close the shift.
      await TrackingService.stop();
      await ref.read(authProvider.notifier).logout();
      // ignore: use_build_context_synchronously
      if (mounted) context.go('/login');
    }
  }
}


/// Explicit duty/tracking state (brief §10: "punch-in starts the
/// location-tracking session; punch-out ends it. Make this explicit in the
/// UI, not implicit").


class _CustomerCard extends StatelessWidget {
  final Customer customer;
  const _CustomerCard({required this.customer});

  Future<void> _dial(BuildContext context) async {
    final uri = Uri(scheme: 'tel', path: customer.mobileNumber);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Cannot open dialer')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasPtp = customer.ptpDate != null;
    // Comparing against `now() + 1 day` (which carries the current
    // time-of-day) meant a PTP due *tomorrow* also satisfied "before
    // tomorrow-at-this-exact-hour" for anyone checking after midnight --
    // inflating the urgent count with promises that aren't actually due
    // yet, which trains agents to ignore the badge. "Due" means today or
    // earlier, so the cutoff is tomorrow's midnight, not now-plus-24h.
    final today = DateTime.now();
    final todayDateOnly = DateTime(today.year, today.month, today.day);
    final ptpDue = hasPtp && customer.ptpDate!.isBefore(todayDateOnly.add(const Duration(days: 1)));

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: ConstrainedBox(
        // Anti-misclick (design brief): every tappable list row ≥56px tall.
        constraints: const BoxConstraints(minHeight: AppDimens.listRow),
        child: ListTile(
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 8,
          ),
          leading: CircleAvatar(
            backgroundColor: ptpDue ? AppColors.warning : AppColors.primary,
            child: Icon(
              ptpDue ? Icons.schedule : Icons.person,
              color: AppColors.onPrimary,
              size: 20,
            ),
          ),
          title: Text(
            customer.customerName,
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
          ),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${customer.loanNumber} · ${customer.companyName}',
                style: const TextStyle(fontSize: 12),
              ),
              if (customer.mobileNumber.isNotEmpty)
                GestureDetector(
                  onTap: () => _dial(context),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.call, size: 12, color: AppColors.success),
                      const SizedBox(width: 4),
                      Text(
                        customer.mobileNumber,
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.success,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
              if (customer.dueAmount != null)
                Text(
                  'Due: ${_rupee.format(customer.dueAmount)}',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ).tabular,
                ),
              if (customer.emi != null)
                Text(
                  'EMI: ${_rupee.format(customer.emi)}',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ).tabular,
                ),
              if (customer.lastResultCode != null)
                Text(
                  'Last: ${customer.lastResultCode}',
                  style: const TextStyle(
                    fontSize: 11,
                    color: AppColors.textTertiary,
                  ),
                ),
              if (hasPtp)
                Text(
                  'PTP: ${_rupee.format(customer.ptpAmount)} on ${DateFormat('dd MMM').format(customer.ptpDate!)}',
                  style: TextStyle(
                    fontSize: 11,
                    color: ptpDue
                        ? AppColors.warningStrong
                        : AppColors.successStrong,
                  ).tabular,
                ),
              if (customer.normalizedPending)
                const Padding(
                  padding: EdgeInsets.only(top: 2),
                  child: Text(
                    'Normalized this month (pending lender confirmation)',
                    style: TextStyle(
                      fontSize: 10,
                      color: AppColors.info,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
            ],
          ),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (customer.mobileNumber.isNotEmpty)
                IconButton(
                  icon: const Icon(Icons.call, color: AppColors.success),
                  tooltip: 'Call',
                  onPressed: () => _dial(context),
                ),
              IconButton(
                icon: const Icon(Icons.note_add_outlined),
                tooltip: 'Log Call',
                onPressed: () => context.push('/customer/${customer.id}/call-log'),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
          onTap: () => context.push('/customer/${customer.id}'),
        ),
      ),
    );
  }
}
