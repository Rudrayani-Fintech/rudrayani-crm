import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
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

/// Own attendance/GPS + receipts for today. /tracking/team-day is
/// self-scoped for a field_agent (Phase 12: tracking.view granted with a
/// self-only fallback in scope.ts), so this always returns exactly one row.
final feAttendanceProvider = FutureProvider.autoDispose<Map<String, dynamic>?>((ref) async {
  final res = await ref.read(apiClientProvider).get('/tracking/team-day');
  final members = (res.data['members'] as List).cast<Map<String, dynamic>>();
  return members.isEmpty ? null : members.first;
});

/// Own route for today -- same self-only scope as above.
final feRouteProvider = FutureProvider.autoDispose<Map<String, dynamic>?>((ref) async {
  final userId = ref.read(authProvider).user?['id'] as String?;
  if (userId == null) return null;
  final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
  final res = await ref
      .read(apiClientProvider)
      .get('/tracking/route', query: {'user_id': userId, 'date': today});
  return res.data as Map<String, dynamic>;
});

/// Daily Target vs Achievement -- same /reports/dashboard as Telecaller,
/// self-scoped for a field_agent too.
final feDashboardProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final month = DateFormat('yyyy-MM').format(DateTime.now());
  final res = await ref.read(apiClientProvider).get('/reports/dashboard', query: {'month': month});
  return res.data as Map<String, dynamic>;
});

/// PTP Created/Kept/Broken, this month, self-scoped.
final feTrailProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final now = DateTime.now();
  final res = await ref.read(apiClientProvider).get('/reports/trail', query: {
    'from': DateFormat('yyyy-MM-01').format(now),
    'to': DateFormat('yyyy-MM-dd').format(now),
  });
  return res.data as Map<String, dynamic>;
});

class FieldExecutiveDashboardScreen extends ConsumerWidget {
  const FieldExecutiveDashboardScreen({super.key});

  void _refresh(WidgetRef ref) {
    ref.invalidate(feAttendanceProvider);
    ref.invalidate(feRouteProvider);
    ref.invalidate(feDashboardProvider);
    ref.invalidate(feTrailProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final attendance = ref.watch(feAttendanceProvider);
    final route = ref.watch(feRouteProvider);
    final dash = ref.watch(feDashboardProvider);
    final trail = ref.watch(feTrailProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Dashboard'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: () => _refresh(ref)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _refresh(ref),
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: [
            const DashboardSectionHeader('Attendance / GPS'),
            attendance.when(
              loading: () => const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.md),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (e, _) => InlineErrorNote(
                message: 'Attendance: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(feAttendanceProvider),
              ),
              data: (m) {
                if (m == null) return const EmptyState(message: 'No attendance record for today yet');
                final onDuty = m['on_duty'] == true;
                final firstIn = m['first_in'] != null
                    ? DateFormat('HH:mm').format(DateTime.parse(m['first_in'] as String).toLocal())
                    : null;
                return DashboardStatGrid(cards: [
                  DashboardStatCard(
                    label: 'Status',
                    value: onDuty ? 'On Duty' : 'Off Duty',
                    accent: onDuty ? AppColors.success : AppColors.textTertiary,
                  ),
                  DashboardStatCard(label: 'Punched In', value: firstIn ?? '—'),
                ]);
              },
            ),

            const SizedBox(height: AppSpacing.sm),
            route.when(
              loading: () => const SizedBox.shrink(),
              error: (e, _) => InlineErrorNote(
                message: 'Route: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(feRouteProvider),
              ),
              data: (r) {
                if (r == null) return const SizedBox.shrink();
                final km = (parseDouble(r['distance_meters']) ?? 0.0) / 1000;
                final points = (r['points'] as List?)?.length ?? 0;
                return DashboardStatGrid(cards: [
                  DashboardStatCard(label: "Today's Distance", value: '${km.toStringAsFixed(1)} km'),
                  DashboardStatCard(label: 'GPS Pings', value: '$points'),
                ]);
              },
            ),

            const DashboardSectionHeader('Receipts & Documents'),
            attendance.when(
              loading: () => const SizedBox.shrink(),
              // Previously silently hidden -- the whole section vanished
              // with no explanation at all when this (shared with
              // Attendance/GPS above) provider failed.
              error: (e, _) => InlineErrorNote(
                message: 'Receipts & Documents: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(feAttendanceProvider),
              ),
              data: (m) {
                if (m == null) return const SizedBox.shrink();
                return DashboardStatGrid(cards: [
                  DashboardStatCard(label: 'Receipts Generated', value: '${m['field_visits'] ?? 0}'),
                  DashboardStatCard(label: 'With Photo', value: '${m['field_visits_with_photo'] ?? 0}'),
                  DashboardStatCard(
                      label: 'With Signature', value: '${m['field_visits_with_signature'] ?? 0}'),
                ]);
              },
            ),

            const DashboardSectionHeader('Daily Target vs Achievement'),
            dash.when(
              loading: () => const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.md),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (e, _) => InlineErrorNote(
                message: 'Target: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(feDashboardProvider),
              ),
              data: (d) {
                final collection = d['collection'] as Map<String, dynamic>;
                final mtd = parseDouble(collection['mtd_amount']) ?? 0.0;
                final target = parseDouble(collection['target_amount']);
                final progress = target != null && target > 0 ? (mtd / target).clamp(0.0, 1.0) : null;
                return DashboardStatGrid(cards: [
                  DashboardStatCard(label: 'Collected MTD', value: '₹ ${_lakh(mtd)}', accent: AppColors.success),
                  DashboardStatCard(
                    label: 'Target',
                    value: target != null ? '₹ ${_lakh(target)}' : '—',
                    sub: progress != null ? '${(progress * 100).toStringAsFixed(0)}% achieved' : null,
                  ),
                ]);
              },
            ),

            const DashboardSectionHeader('PTP Created / Kept / Broken (This Month)'),
            trail.when(
              loading: () => const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.md),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (e, _) => InlineErrorNote(
                message: 'PTP summary: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(feTrailProvider),
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
              ]),
            ),

            const DashboardSectionHeader('Not Yet Available'),
            const DashboardGapCard(
              title: 'Visits Planned',
              reason: 'No distinct visit-queue exists yet — only completed visits are tracked.',
            ),
            const SizedBox(height: AppSpacing.xs),
            const DashboardGapCard(
              title: 'Customer Location',
              reason: 'Only the agent\'s GPS point at visit time is stored — no registered customer address.',
            ),
          ],
        ),
      ),
    );
  }
}
