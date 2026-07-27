import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/widgets/state_views.dart';
import '../../core/utils/parser.dart';

/// "My Performance" (Phase 5): the same /reports/dashboard endpoint as the
/// web — the server clamps the scope to the signed-in user, so this shows
/// the agent's own book, collection vs target, and per-metric MTD.
final performanceProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final month = DateFormat('yyyy-MM').format(DateTime.now());
  final res = await ref
      .read(apiClientProvider)
      .get('/reports/dashboard', query: {'month': month});
  return res.data as Map<String, dynamic>;
});

String _lakh(num? v) {
  if (v == null) return '—';
  final l = v / 100000;
  if (l.abs() >= 0.01) return '${l.toStringAsFixed(2)}L';
  return NumberFormat.decimalPattern('en_IN').format(v);
}

String _pct(num? v) => v == null ? '—' : '${v.toStringAsFixed(1)}%';

const _metricTitles = {
  'resolution': 'Resolution',
  'rollback': 'Roll Back',
  'normalization': 'Normalization',
  'recovery': 'Recovery',
};

class PerformanceScreen extends ConsumerWidget {
  const PerformanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(performanceProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text('My Performance (${DateFormat('MMM yyyy').format(DateTime.now())})'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(performanceProvider),
          ),
        ],
      ),
      body: data.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorState(
          message: 'Could not load your performance.\n${friendlyError(e)}',
          onRetry: () => ref.invalidate(performanceProvider),
        ),
        data: (d) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(performanceProvider),
          child: _PerformanceBody(data: d),
        ),
      ),
    );
  }
}

class _PerformanceBody extends StatelessWidget {
  final Map<String, dynamic> data;
  const _PerformanceBody({required this.data});

  @override
  Widget build(BuildContext context) {
    final days = data['days'] as Map<String, dynamic>;
    final collection = data['collection'] as Map<String, dynamic>;
    final allocated = data['allocated'] as Map<String, dynamic>;
    final metrics = data['metrics'] as Map<String, dynamic>;
    final trail = data['trail'] as Map<String, dynamic>;

    final mtd = parseDouble(collection['mtd_amount']) ?? 0.0;
    final target = parseDouble(collection['target_amount']);
    final progress =
        target != null && target > 0 ? (mtd / target).clamp(0.0, 1.0) : null;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Collection vs target — the headline card
        Card(
          color: AppColors.primaryDark,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.xl)),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Collection this month',
                        style: TextStyle(color: AppColors.onPrimary.withValues(alpha: 0.7), fontSize: 13)),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.onPrimary.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text('${days['left']} days left',
                          style: const TextStyle(color: AppColors.onPrimary, fontSize: 11)),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  '₹ ${_lakh(mtd)}',
                  style: const TextStyle(
                      color: AppColors.success, fontSize: 32, fontWeight: FontWeight.bold).tabular,
                ),
                Text(
                  target != null
                      ? 'of ₹ ${_lakh(target)} target'
                      : 'No target set for this month',
                  style: TextStyle(color: AppColors.onPrimary.withValues(alpha: 0.7), fontSize: 13).tabular,
                ),
                if (progress != null) ...[
                  const SizedBox(height: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: LinearProgressIndicator(
                      value: progress,
                      minHeight: 10,
                      backgroundColor: AppColors.onPrimary.withValues(alpha: 0.15),
                      valueColor: const AlwaysStoppedAnimation(AppColors.success),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    mtd >= target!
                        ? 'Target achieved! 🎉'
                        : '₹ ${_lakh(target - mtd)} to go'
                          ' · need ₹ ${_lakh(parseDouble(collection['run_rate_required']))} per day',
                    style: TextStyle(color: AppColors.onPrimary.withValues(alpha: 0.7), fontSize: 12).tabular,
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),

        // My book + trail coverage
        Row(
          children: [
            Expanded(
              child: _StatCard(
                label: 'My accounts',
                value: '${allocated['count']}',
                sub: '₹ ${_lakh(parseDouble(allocated['amount']))} POS',
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _StatCard(
                label: 'Worked (trail)',
                value: '${trail['uploaded_count']} / ${trail['allocated_count']}',
                sub: _pct(parseDouble(trail['pct'])),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),

        const Padding(
          padding: EdgeInsets.symmetric(vertical: 4),
          child: Text('Metrics',
              style: TextStyle(
                  fontWeight: FontWeight.bold, fontSize: 14, color: AppColors.primary)),
        ),
        for (final entry in _metricTitles.entries)
          _MetricRow(
            title: entry.value,
            metric: metrics[entry.key] as Map<String, dynamic>,
          ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  final String label;
  final String value;
  final String sub;
  const _StatCard({required this.label, required this.value, required this.sub});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textTertiary)),
            const SizedBox(height: AppSpacing.xs),
            Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold).tabular),
            Text(sub, style: const TextStyle(fontSize: 12, color: AppColors.textTertiary).tabular),
          ],
        ),
      ),
    );
  }
}

class _MetricRow extends StatelessWidget {
  final String title;
  final Map<String, dynamic> metric;
  const _MetricRow({required this.title, required this.metric});

  @override
  Widget build(BuildContext context) {
    final mtd = parseDouble(metric['mtd_amount']);
    final target = parseDouble(metric['target_amount']);
    final pctVal = parseDouble(metric['mtd_pct']);
    final progress = target != null && target > 0
        ? ((mtd ?? 0) / target).clamp(0.0, 1.0)
        : null;

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                Text(_pct(pctVal),
                    style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                        color: AppColors.primary).tabular),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              target != null
                  ? '₹ ${_lakh(mtd)} of ₹ ${_lakh(target)} target'
                  : '₹ ${_lakh(mtd)} MTD · no target set',
              style: const TextStyle(fontSize: 12, color: AppColors.textTertiary).tabular,
            ),
            if (progress != null) ...[
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: progress,
                  minHeight: 6,
                  backgroundColor: AppColors.primarySurface,
                  valueColor: const AlwaysStoppedAnimation(AppColors.primary),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
