import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/ui/ui.dart';
import '../../core/utils/friendly_error.dart';

/// Every agent in the branch manager's branch, today's numbers --
/// `GET /tracking/team-day` is scope-clamped server-side (`scopeFilter()`)
/// to exactly the caller's branch, so no branch id needs to be sent.
final _branchTeamDayProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final api = ref.read(apiClientProvider);
  final res = await api.get<Map<String, dynamic>>('/tracking/team-day');
  return (res.data!['members'] as List).cast<Map<String, dynamic>>();
});

/// Branch (Q3, branch managers only): per-agent on-duty/contacted/collected/
/// PTPs, tapping through to that agent's day. No target, no percentage.
class BranchScreen extends ConsumerWidget {
  const BranchScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(_branchTeamDayProvider);

    return AppScaffold(
      title: 'Branch',
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(_branchTeamDayProvider),
        child: members.when(
          loading: () => const AppLoadingState(),
          error: (e, _) => AppErrorState(
            message: 'Could not load your branch.\n${friendlyError(e)}',
            onRetry: () => ref.invalidate(_branchTeamDayProvider),
          ),
          data: (rows) {
            if (rows.isEmpty) {
              return const AppEmptyState(message: 'No agents in your branch yet.');
            }
            return ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: rows.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (ctx, i) => _AgentRow(row: rows[i]),
            );
          },
        ),
      ),
    );
  }
}

class _AgentRow extends StatelessWidget {
  final Map<String, dynamic> row;
  const _AgentRow({required this.row});

  @override
  Widget build(BuildContext context) {
    final onDuty = row['on_duty'] == true;
    return AppListRow(
      onTap: () => _showAgentDaySheet(context, row),
      leading: Icon(Icons.circle, size: 12, color: onDuty ? AppColors.success : AppColors.textTertiary),
      title: Text(row['full_name'] as String? ?? 'Agent'),
      subtitle: Text('Contacted: ${row['calls'] ?? 0} · PTPs: ${row['ptps'] ?? 0}'),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppMoney(row['payments_total'] as num?, style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(width: AppSpacing.xs),
          const Icon(Icons.chevron_right),
        ],
      ),
    );
  }
}

/// "Tapping through to that agent's day" (§5.1) -- the row already carries
/// everything a day view would show, so this surfaces it larger rather than
/// firing a second network request for data already in hand.
void _showAgentDaySheet(BuildContext context, Map<String, dynamic> row) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(row['full_name'] as String? ?? 'Agent', style: Theme.of(ctx).textTheme.headlineSmall),
            const SizedBox(height: AppSpacing.md),
            Wrap(
              spacing: AppSpacing.md,
              runSpacing: AppSpacing.md,
              children: [
                AppStatTile(
                  label: 'Status',
                  value: Text(row['on_duty'] == true ? 'On duty' : 'Off duty'),
                  accentColor: row['on_duty'] == true ? AppColors.success : AppColors.textTertiary,
                ),
                AppStatTile(label: 'Contacted', value: Text('${row['calls'] ?? 0}')),
                AppStatTile(
                  label: 'Collected',
                  value: AppMoney(row['payments_total'] as num?),
                  accentColor: AppColors.success,
                ),
                AppStatTile(label: 'PTPs set', value: Text('${row['ptps'] ?? 0}')),
                AppStatTile(label: 'Visits', value: Text('${row['field_visits'] ?? 0}')),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),
          ],
        ),
      ),
    ),
  );
}
