import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/state_views.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/utils/parser.dart';
import 'package:go_router/go_router.dart';
import 'dashboard_widgets.dart';

String _lakh(num? v) {
  if (v == null) return '—';
  final l = v / 100000;
  if (l.abs() >= 0.01) return '${l.toStringAsFixed(2)}L';
  return NumberFormat.decimalPattern('en_IN').format(v);
}

// Business rule confirmed against Trail_Codes.xlsx (report-service.ts
// trailAnalytics()): a call counts as "connected" (reached the customer or
// someone who could speak for them) unless the result code is NC (Not
// Connected) or OSER (Out of Service). Everything else -- PTP, RTP, RNR,
// etc. -- implies the call went through.
const _notConnectedCodes = {'NC', 'OSER'};

/// Same /reports/dashboard the Management Dashboard and "My Performance" use
/// -- self-scoped automatically for a plain telecaller (reports.view_self),
/// giving Collection Today/MTD and the target-vs-achievement figures for
/// free.
final teleDashboardProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final month = DateFormat('yyyy-MM').format(DateTime.now());
  final res = await ref.read(apiClientProvider).get('/reports/dashboard', query: {'month': month});
  return res.data as Map<String, dynamic>;
});

/// This month's trail (own calls only, self-scoped) -- backs RPC/Connected
/// Calls, Escalation Cases, and PTP Created/Kept/Broken.
final teleTrailProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final now = DateTime.now();
  final res = await ref.read(apiClientProvider).get('/reports/trail', query: {
    'from': DateFormat('yyyy-MM-01').format(now),
    'to': DateFormat('yyyy-MM-dd').format(now),
  });
  return res.data as Map<String, dynamic>;
});

class TelecallerDashboardScreen extends ConsumerWidget {
  const TelecallerDashboardScreen({super.key});

  void _refresh(WidgetRef ref) {
    ref.invalidate(teleDashboardProvider);
    ref.invalidate(teleTrailProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dash = ref.watch(teleDashboardProvider);
    final trail = ref.watch(teleTrailProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Dashboard'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: () => _refresh(ref)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _refresh(ref),
        child: dash.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ErrorState(message: 'Could not load your dashboard.\n${friendlyError(e)}', onRetry: () => _refresh(ref)),
          data: (d) {
            final collection = d['collection'] as Map<String, dynamic>;
            final mtd = parseDouble(collection['mtd_amount']) ?? 0.0;
            final today = parseDouble(collection['today_amount']) ?? 0.0;
            final target = parseDouble(collection['target_amount']);
            final progress = target != null && target > 0 ? (mtd / target).clamp(0.0, 1.0) : null;

            return ListView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              children: [
                const DashboardSectionHeader('Collection'),
                DashboardStatGrid(cards: [
                  DashboardStatCard(label: 'Today', value: '₹ ${_lakh(today)}', accent: AppColors.success),
                  DashboardStatCard(label: 'MTD', value: '₹ ${_lakh(mtd)}'),
                ]),

                const DashboardSectionHeader('Daily Target vs Achievement'),
                _TargetCard(mtd: mtd.toDouble(), target: target?.toDouble(), progress: progress),

                const DashboardSectionHeader('Calls'),
                trail.when(
                  loading: () => const Padding(
                    padding: EdgeInsets.symmetric(vertical: AppSpacing.md),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (e, _) => InlineErrorNote(
                    message: 'Calls: ${friendlyError(e)}',
                    onRetry: () => ref.invalidate(teleTrailProvider),
                  ),
                  data: (t) {
                    final total = parseInt(t['total_trails']) ?? 0;
                    final byResult = (t['by_result_code'] as List).cast<Map<String, dynamic>>();
                    final notConnected = byResult
                        .where((r) => _notConnectedCodes.contains(r['result_code']))
                        .fold<int>(0, (s, r) => s + (parseInt(r['count']) ?? 0));
                    final connected = total - notConnected;
                    return DashboardStatGrid(cards: [
                      DashboardStatCard(label: 'Total Calls', value: '$total'),
                      DashboardStatCard(
                          label: 'RPC / Connected', value: '$connected', accent: AppColors.success),
                      DashboardStatCard(
                          label: 'Escalation Cases',
                          value: '${t['escalated_count'] ?? 0}',
                          accent: AppColors.error),
                    ]);
                  },
                ),

                const DashboardSectionHeader('PTP Created / Kept / Broken (This Month)'),
                trail.when(
                  loading: () => const SizedBox.shrink(),
                  error: (e, _) => InlineErrorNote(
                    message: 'PTP summary: ${friendlyError(e)}',
                    onRetry: () => ref.invalidate(teleTrailProvider),
                  ),
                  data: (t) => DashboardStatGrid(cards: [
                    DashboardStatCard(
                        label: 'Created',
                        value: '${t['ptps_created'] ?? 0}',
                        onTap: () => context.push('/account/ptps/pending')),
                    DashboardStatCard(
                        label: 'Kept',
                        value: '${t['ptps_kept'] ?? 0}',
                        accent: AppColors.success,
                        onTap: () => context.push('/account/ptps/kept')),
                    DashboardStatCard(
                        label: 'Broken',
                        value: '${t['ptps_broken'] ?? 0}',
                        accent: AppColors.error,
                        onTap: () => context.push('/account/ptps/broken')),
                    DashboardStatCard(
                        label: 'Pending Value', value: '₹ ${_lakh(parseDouble(t['ptps_pending_value']))}'),
                  ]),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _TargetCard extends StatelessWidget {
  final double mtd;
  final double? target;
  final double? progress;
  const _TargetCard({required this.mtd, this.target, this.progress});

  @override
  Widget build(BuildContext context) {
    return Card(
      color: AppColors.primaryDark,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.xl)),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '₹ ${_lakh(mtd)}',
              style: const TextStyle(color: AppColors.success, fontSize: 28, fontWeight: FontWeight.bold)
                  .tabular,
            ),
            Text(
              target != null ? 'of ₹ ${_lakh(target)} target' : 'No target set for this month',
              style: const TextStyle(color: Colors.white70, fontSize: 13),
            ),
            if (progress != null) ...[
              const SizedBox(height: AppSpacing.sm),
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: LinearProgressIndicator(
                  value: progress,
                  minHeight: 10,
                  backgroundColor: Colors.white.withValues(alpha: 0.15),
                  valueColor: const AlwaysStoppedAnimation(AppColors.success),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
