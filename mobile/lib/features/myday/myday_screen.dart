import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/app_theme.dart';
import '../../core/ui/ui.dart';
import '../../core/utils/friendly_error.dart';

/// One agent's row from `GET /tracking/team-day` -- self-scoped for a plain
/// field agent/telecaller (`scopeFilter()` clamps it to exactly one row:
/// their own), so no client-side filtering by id is needed here. The same
/// endpoint backs the Branch screen's per-agent list.
Map<String, dynamic>? findSelfRow(List<Map<String, dynamic>> members, String? userId) {
  if (members.isEmpty) return null;
  if (userId == null) return members.first;
  for (final m in members) {
    if (m['user_id'] == userId) return m;
  }
  return members.first;
}

final _todayProvider = FutureProvider.autoDispose<Map<String, dynamic>?>((ref) async {
  final api = ref.read(apiClientProvider);
  final userId = ref.read(authProvider).user?['id'] as String?;
  final res = await api.get<Map<String, dynamic>>('/tracking/team-day');
  final members = (res.data!['members'] as List).cast<Map<String, dynamic>>();
  return findSelfRow(members, userId);
});

/// "This month" figures (P4, P5, ledger not KPIs). `/tracking/team-day` only
/// takes a single `date`, and `/reports/agent-activity` has no date-range
/// filter (confirmed while researching Phase 10's progress line) -- so the
/// month view composes two range-capable, already-kept endpoints instead:
/// `/reports/trail` for contacted/PTPs-set counts, `/reports/overview` for
/// the collected total. Both are self-scoped automatically by the same
/// `resolveReportScope()`/`scopeFilter()` machinery as every other report.
final _monthProvider =
    FutureProvider.autoDispose<({int contacted, int ptpsSet, double collected})>((ref) async {
  final api = ref.read(apiClientProvider);
  final now = DateTime.now();
  final from = DateFormat('yyyy-MM-01').format(now);
  final to = DateFormat('yyyy-MM-dd').format(now);
  final results = await Future.wait([
    api.get<Map<String, dynamic>>('/reports/trail', query: {'from': from, 'to': to}),
    api.get<Map<String, dynamic>>('/reports/overview', query: {'months': 1}),
  ]);
  final trail = results[0].data!;
  final overview = results[1].data!;
  return (
    contacted: (trail['total_trails'] as num?)?.toInt() ?? 0,
    ptpsSet: (trail['ptps_created'] as num?)?.toInt() ?? 0,
    collected: (overview['total'] as num?)?.toDouble() ?? 0.0,
  );
});

/// My Day (P4, P5, N6): replaces My Performance. The ledger view -- contacted,
/// collected, PTPs set, visits -- with no target, no percentage, no gauge
/// anywhere on the screen.
class MyDayScreen extends ConsumerWidget {
  const MyDayScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final today = ref.watch(_todayProvider);
    final month = ref.watch(_monthProvider);

    return AppScaffold(
      title: 'My Day',
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(_todayProvider);
          ref.invalidate(_monthProvider);
        },
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: [
            AppSectionHeader(title: 'Today'),
            today.when(
              loading: () => const AppLoadingState(),
              error: (e, _) => AppInlineErrorNote(
                message: 'Could not load today\'s numbers: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(_todayProvider),
              ),
              data: (row) {
                if (row == null) {
                  return const AppEmptyState(message: 'No activity recorded yet today.');
                }
                return _StatWrap(tiles: [
                  AppStatTile(label: 'Contacted', value: Text('${row['calls'] ?? 0}')),
                  AppStatTile(
                    label: 'Collected',
                    value: AppMoney(row['payments_total'] as num?),
                    accentColor: AppColors.success,
                  ),
                  AppStatTile(label: 'PTPs set', value: Text('${row['ptps'] ?? 0}')),
                  AppStatTile(label: 'Visits', value: Text('${row['field_visits'] ?? 0}')),
                ]);
              },
            ),
            const SizedBox(height: AppSpacing.xl),
            AppSectionHeader(title: 'This Month'),
            month.when(
              loading: () => const AppLoadingState(),
              error: (e, _) => AppInlineErrorNote(
                message: 'Could not load this month\'s numbers: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(_monthProvider),
              ),
              data: (m) => _StatWrap(tiles: [
                AppStatTile(label: 'Contacted', value: Text('${m.contacted}')),
                AppStatTile(label: 'Collected', value: AppMoney(m.collected, compact: true), accentColor: AppColors.success),
                AppStatTile(label: 'PTPs set', value: Text('${m.ptpsSet}')),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}

/// Two-per-row stat grid -- `AppStatTile` sizes to its content, not a fixed
/// grid cell, so a `Wrap` fits it better than a `GridView` here.
class _StatWrap extends StatelessWidget {
  final List<Widget> tiles;
  const _StatWrap({required this.tiles});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final tileWidth = (constraints.maxWidth - AppSpacing.md) / 2;
        return Wrap(
          spacing: AppSpacing.md,
          runSpacing: AppSpacing.md,
          children: [for (final t in tiles) SizedBox(width: tileWidth, child: t)],
        );
      },
    );
  }
}
