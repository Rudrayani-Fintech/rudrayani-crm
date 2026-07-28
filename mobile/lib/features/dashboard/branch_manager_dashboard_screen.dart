import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/state_views.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/utils/money.dart' as money;
import '../../core/utils/parser.dart';
import 'dashboard_widgets.dart';

String _lakh(num? v) => money.lakh(v);

/// Branch-wide "today" snapshot -- scopeFilter() already resolves a
/// branch_manager to their whole branch (including multi-branch telecallers
/// assigned there via telecaller_branches), so no branch_id param is needed.
final bmBranchDayProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.read(apiClientProvider).get('/tracking/team-day');
  return (res.data['members'] as List).cast<Map<String, dynamic>>();
});

/// Per-team breakdown for the branch -- a branch_manager's unit of
/// drill-down is teams, not individual agents directly, so this reuses
/// /reports/breakdown?dimension=team (already branch-clamped via
/// resolveReportScope) instead of a flat member list.
final bmTeamBreakdownProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final now = DateTime.now();
  final month = DateFormat('yyyy-MM').format(now);
  final res = await ref.read(apiClientProvider).get('/reports/breakdown', query: {
    'month': month,
    'dimension': 'team',
  });
  return (res.data['rows'] as List).cast<Map<String, dynamic>>();
});

/// Pending reallocation-approval requests across the branch_manager's whole
/// branch (Phase 2: absorbed from the old team_leader-only TeamScreen -- a
/// branch_manager now covers every team in their branch directly, so this
/// is the one home for the workflow on mobile, reusing the exact same
/// endpoint/decision flow web already uses unmodified).
final pendingRequestsProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.read(apiClientProvider).get('/reallocation-requests');
  return (res.data['requests'] as List).cast<Map<String, dynamic>>();
});

class BranchManagerDashboardScreen extends ConsumerWidget {
  const BranchManagerDashboardScreen({super.key});

  void _refresh(WidgetRef ref) {
    ref.invalidate(bmBranchDayProvider);
    ref.invalidate(bmTeamBreakdownProvider);
    ref.invalidate(pendingRequestsProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final branchDay = ref.watch(bmBranchDayProvider);
    final teamBreakdown = ref.watch(bmTeamBreakdownProvider);
    final requests = ref.watch(pendingRequestsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Branch Dashboard'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: () => _refresh(ref)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _refresh(ref),
        child: branchDay.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ErrorState(message: 'Could not load the branch dashboard.\n${friendlyError(e)}', onRetry: () => _refresh(ref)),
          data: (members) {
            if (members.isEmpty) {
              return const EmptyState(message: 'No branch members found', hint: 'Ask an admin to assign this branch');
            }
            return ListView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              children: [
                requests.when(
                  loading: () => const SizedBox.shrink(),
                  error: (e, _) => InlineErrorNote(
                    message: 'Approvals: ${friendlyError(e)}',
                    onRetry: () => ref.invalidate(pendingRequestsProvider),
                  ),
                  data: (reqs) => reqs.isEmpty
                      ? const SizedBox.shrink()
                      : _ApprovalsSection(requests: reqs, onDecided: () => _refresh(ref)),
                ),

                const DashboardSectionHeader('Attendance / GPS (Branch-wide)'),
                _AttendanceSummary(members: members),

                const DashboardSectionHeader('Collections Today'),
                _CollectionsSummary(members: members),

                const DashboardSectionHeader('Teams in this Branch'),
                teamBreakdown.when(
                  loading: () => const Padding(
                    padding: EdgeInsets.symmetric(vertical: AppSpacing.md),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (e, _) => InlineErrorNote(
                    message: 'Team breakdown: ${friendlyError(e)}',
                    onRetry: () => ref.invalidate(bmTeamBreakdownProvider),
                  ),
                  data: (rows) => rows.isEmpty
                      ? const Padding(
                          padding: EdgeInsets.symmetric(vertical: AppSpacing.md),
                          child: Text('No teams with activity this month', style: TextStyle(color: AppColors.textSecondary)),
                        )
                      : Column(children: [for (final r in rows) _TeamRow(row: r)]),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _AttendanceSummary extends StatelessWidget {
  final List<Map<String, dynamic>> members;
  const _AttendanceSummary({required this.members});

  @override
  Widget build(BuildContext context) {
    final onDuty = members.where((m) => m['on_duty'] == true).length;
    return DashboardStatGrid(cards: [
      DashboardStatCard(label: 'On Duty', value: '$onDuty / ${members.length}', accent: AppColors.success),
      DashboardStatCard(
        label: 'Punched In',
        value: '${members.where((m) => m['first_in'] != null).length}',
      ),
    ]);
  }
}

class _CollectionsSummary extends StatelessWidget {
  final List<Map<String, dynamic>> members;
  const _CollectionsSummary({required this.members});

  @override
  Widget build(BuildContext context) {
    final cash = members.fold<double>(0, (s, m) => s + (parseDouble(m['cash_total']) ?? 0.0));
    final online = members.fold<double>(0, (s, m) => s + (parseDouble(m['online_total']) ?? 0.0));
    return DashboardStatGrid(cards: [
      DashboardStatCard(label: 'Cash', value: '₹ ${_lakh(cash)}', accent: AppColors.success),
      DashboardStatCard(label: 'Online', value: '₹ ${_lakh(online)}', accent: AppColors.info),
    ]);
  }
}

/// Tapping a team drills into its member roster (reuses the same
/// /account/team/:id/members route + EmployeeDetailScreen chain built for
/// the "My Teams" list, see router.dart) -- one drill-down pattern, multiple
/// entry points.
class _TeamRow extends StatelessWidget {
  final Map<String, dynamic> row;
  const _TeamRow({required this.row});

  @override
  Widget build(BuildContext context) {
    final key = row['key'] as String?;
    final achievement = parseDouble(row['achievement_pct']);
    return Container(
      constraints: const BoxConstraints(minHeight: AppDimens.listRow),
      margin: const EdgeInsets.only(bottom: AppSpacing.xs),
      child: Material(
        color: AppColors.neutralContainer,
        borderRadius: BorderRadius.circular(AppRadius.md),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadius.md),
          onTap: key == null ? null : () => context.push('/account/team/$key/members'),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(row['label'] as String? ?? '—',
                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                      Text(
                        '₹ ${_lakh(parseDouble(row['collected_amount']))} collected'
                        '${achievement != null ? ' · ${achievement.toStringAsFixed(1)}%' : ''}',
                        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary).tabular,
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: AppColors.textSecondary),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Reallocation-approval workflow (moved here from the old team_leader-only
/// TeamScreen -- see the file-level doc comment on pendingRequestsProvider).
class _ApprovalsSection extends ConsumerWidget {
  final List<Map<String, dynamic>> requests;
  final VoidCallback onDecided;
  const _ApprovalsSection({required this.requests, required this.onDecided});

  Future<void> _decide(
    BuildContext context,
    WidgetRef ref,
    Map<String, dynamic> request,
    bool approve,
  ) async {
    String? newAgentId;
    if (approve) {
      // Pick a new agent from the branch, or return to the unallocated pool.
      final members = ref.read(bmBranchDayProvider).valueOrNull ?? [];
      final candidates =
          members.where((m) => m['user_id'] != request['requested_by_id']).toList();
      final choice = await showModalBottomSheet<String>(
        context: context,
        builder: (ctx) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: [
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('Assign to…',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
              ),
              // Anti-misclick: every tappable sheet row ≥56px tall.
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: AppDimens.listRow),
                child: ListTile(
                  leading: const Icon(Icons.inbox),
                  title: const Text('Return to unallocated pool'),
                  onTap: () => Navigator.pop(ctx, ''),
                ),
              ),
              for (final m in candidates)
                ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: AppDimens.listRow),
                  child: ListTile(
                    leading: const Icon(Icons.person),
                    title: Text(m['full_name'] as String),
                    onTap: () => Navigator.pop(ctx, m['user_id'] as String),
                  ),
                ),
            ],
          ),
        ),
      );
      if (choice == null) return; // cancelled
      newAgentId = choice.isEmpty ? null : choice;
    }

    try {
      await ref.read(apiClientProvider).post(
        '/reallocation-requests/${request['id']}/decide',
        data: {
          'approve': approve,
          'new_agent_id': ?newAgentId,
        },
      );
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(approve ? 'Request approved' : 'Request rejected'),
          backgroundColor: approve ? AppColors.success : AppColors.textSecondary,
        ));
      }
      onDecided();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Failed: ${friendlyError(e)}'), backgroundColor: AppColors.error));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Reallocation Approvals (${requests.length})',
            style: const TextStyle(
                fontWeight: FontWeight.bold, fontSize: 14, color: AppColors.primary)),
        const SizedBox(height: 8),
        for (final r in requests)
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            color: AppColors.warningContainer,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${r['customer_name']} · ${r['loan_number']}',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  Text('Requested by ${r['requested_by_name']}',
                      style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                  const SizedBox(height: 4),
                  Text('"${r['reason']}"', style: const TextStyle(fontSize: 13)),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton(
                          onPressed: () => _decide(context, ref, r, true),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.primary,
                            foregroundColor: AppColors.onPrimary,
                          ),
                          child: const Text('Approve'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => _decide(context, ref, r, false),
                          style: OutlinedButton.styleFrom(foregroundColor: AppColors.error),
                          child: const Text('Reject'),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
