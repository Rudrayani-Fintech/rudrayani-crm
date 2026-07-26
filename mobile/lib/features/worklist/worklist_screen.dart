import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/models/customer.dart';
import '../../core/offline/offline_queue.dart';
import '../../core/theme/app_theme.dart';
import '../../core/tracking/tracking_service.dart';
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

class _WorklistScreenState extends ConsumerState<WorklistScreen> {
  String _search = '';
  String? _selectedCompany;

  @override
  void initState() {
    super.initState();
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
          const _SyncBanner(),
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
                  onChanged: (v) => setState(() => _search = v.toLowerCase()),
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
                    return DropdownButton<String?>(
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
                message: 'Could not load your worklist.\n$e',
                onRetry: () {
                  ref.invalidate(worklistProvider);
                  ref.invalidate(dispositionCodesProvider);
                },
              ),
              data: (customers) {
                // Track 7.2: Client-side company filter
                var filtered = _selectedCompany != null
                    ? customers
                        .where((c) => c.companyName == _selectedCompany)
                        .toList()
                    : customers;

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

                // Extract distinct companies for filter dropdown (unused for now)
                // final companies = customers
                //     .map((c) => c.companyName)
                //     .toSet()
                //     .toList()
                //     ..sort();

                if (filtered.isEmpty) {
                  return const EmptyState(
                    icon: Icons.people_outline,
                    message: 'No customers assigned today.',
                    hint: 'Pull down to refresh once new accounts land.',
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

/// Offline-queue state: how many actions are waiting to sync, and the last
/// permanent rejection if the server refused one (brief §8 offline mode).
class _SyncBanner extends ConsumerWidget {
  const _SyncBanner();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = ref.watch(offlineQueueProvider);
    if (q.pending == 0 && q.lastError == null) return const SizedBox.shrink();

    return Container(
      width: double.infinity,
      color: q.lastError != null
          ? AppColors.errorContainer
          : AppColors.warningContainer,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Row(
        children: [
          Icon(
            q.lastError != null
                ? Icons.error_outline
                : Icons.cloud_upload_outlined,
            size: 16,
            color: q.lastError != null
                ? AppColors.errorStrong
                : AppColors.warningStrong,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              q.lastError ??
                  (q.syncing
                      ? 'Syncing ${q.pending} offline action(s)…'
                      : '${q.pending} action(s) waiting to sync'),
              style: TextStyle(
                fontSize: 12,
                color: q.lastError != null
                    ? AppColors.errorStrong
                    : AppColors.warningStrong,
              ),
            ),
          ),
          if (q.lastError != null)
            TextButton(
              onPressed: () =>
                  ref.read(offlineQueueProvider.notifier).clearError(),
              child: const Text('Dismiss', style: TextStyle(fontSize: 12)),
            )
          else if (!q.syncing)
            TextButton(
              onPressed: () => ref.read(offlineQueueProvider.notifier).flush(),
              child: const Text('Sync now', style: TextStyle(fontSize: 12)),
            ),
        ],
      ),
    );
  }
}

/// Explicit duty/tracking state (brief §10: "punch-in starts the
/// location-tracking session; punch-out ends it. Make this explicit in the
/// UI, not implicit").


class _CustomerCard extends StatelessWidget {
  final Customer customer;
  const _CustomerCard({required this.customer});

  @override
  Widget build(BuildContext context) {
    final hasPtp = customer.ptpDate != null;
    final ptpDue =
        hasPtp &&
        customer.ptpDate!.isBefore(DateTime.now().add(const Duration(days: 1)));

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
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push('/customer/${customer.id}'),
        ),
      ),
    );
  }
}
