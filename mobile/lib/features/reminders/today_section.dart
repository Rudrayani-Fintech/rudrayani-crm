import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/theme/app_theme.dart';
import 'reminders_provider.dart';
import '../../core/utils/parser.dart';

final _rupee = NumberFormat.currency(
  locale: 'en_IN',
  symbol: '₹',
  decimalDigits: 0,
);
final _time = DateFormat('HH:mm');

/// Collapsible strip of everything due today: manual reminders (swipe/tap to
/// mark done) plus PTPs due or overdue (read-only here — PTPs are actioned by
/// logging a new call, not marked done directly).
///
/// When [heroMode] is true (used in HomeShell above all tabs) the card uses a
/// stronger accent and a count badge on the header to make it feel like the
/// primary call-to-action rather than a secondary strip.
class TodaySection extends ConsumerStatefulWidget {
  final bool heroMode;
  const TodaySection({super.key, this.heroMode = false});

  @override
  ConsumerState<TodaySection> createState() => _TodaySectionState();
}

class _TodaySectionState extends ConsumerState<TodaySection> {
  bool _expanded = true;

  @override
  Widget build(BuildContext context) {
    final reminders = ref.watch(remindersTodayProvider);
    final ptps = ref.watch(ptpsDueTodayProvider);

    final reminderCount = reminders.valueOrNull?.length ?? 0;
    final ptpCount = ptps.valueOrNull?.length ?? 0;
    final total = reminderCount + ptpCount;

    if (total == 0 && !reminders.isLoading && !ptps.isLoading) {
      return const SizedBox.shrink();
    }

    final hero = widget.heroMode;
    final margin = hero
        ? const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 0)
        : const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 0);

    return Card(
      margin: margin,
      color: hero ? AppColors.primary : AppColors.warningContainer,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(hero ? AppRadius.xl : AppRadius.md),
      ),
      child: Column(
        children: [
          ListTile(
            dense: !hero,
            contentPadding: hero
                ? const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.xs)
                : null,
            leading: Icon(
              Icons.today,
              color: hero ? AppColors.onPrimary : AppColors.primary,
              size: hero ? 22 : 18,
            ),
            title: Text(
              "Today's Actions",
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: hero ? 14 : 13,
                color: hero ? AppColors.onPrimary : null,
              ),
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (total > 0)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: hero
                          ? AppColors.onPrimary.withValues(alpha: 0.2)
                          : AppColors.primary.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(AppRadius.full),
                    ),
                    child: Text(
                      '$total',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                        color: hero ? AppColors.onPrimary : AppColors.primary,
                      ),
                    ),
                  ),
                IconButton(
                  icon: Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    color: hero ? AppColors.onPrimary : null,
                  ),
                  onPressed: () => setState(() => _expanded = !_expanded),
                ),
              ],
            ),
            onTap: () => setState(() => _expanded = !_expanded),
          ),
          if (_expanded) ...[
            for (final r in reminders.valueOrNull ?? const [])
              _ReminderTile(reminder: r, heroMode: hero),
            for (final p in ptps.valueOrNull ?? const [])
              _PtpTile(ptp: p, heroMode: hero),
            const SizedBox(height: 4),
          ],
        ],
      ),
    );
  }
}

class _ReminderTile extends ConsumerWidget {
  final Map<String, dynamic> reminder;
  final bool heroMode;
  const _ReminderTile({required this.reminder, this.heroMode = false});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remindAt = DateTime.parse(reminder['remind_at'] as String).toLocal();
    final customerName = reminder['customer_name'] as String?;
    final note = reminder['note'] as String?;
    final textColor = heroMode ? AppColors.onPrimary : null;

    return ListTile(
      dense: true,
      leading: Icon(
        Icons.notifications_active,
        size: 18,
        color: heroMode ? AppColors.onPrimary.withValues(alpha: 0.8) : AppColors.warning,
      ),
      title: Text(
        customerName ?? (note?.isNotEmpty == true ? note! : 'Reminder'),
        style: TextStyle(fontSize: 13, color: textColor),
      ),
      subtitle: Text(
        [
          _time.format(remindAt),
          if (customerName != null && note?.isNotEmpty == true) note,
        ].join(' · '),
        style: TextStyle(
          fontSize: 11,
          color: heroMode ? AppColors.onPrimary.withValues(alpha: 0.65) : AppColors.textTertiary,
        ),
      ),
      trailing: IconButton(
        icon: Icon(
          Icons.check_circle_outline,
          size: 20,
          color: heroMode ? AppColors.onPrimary : null,
        ),
        tooltip: 'Mark done',
        onPressed: () async {
          try {
            await ref
                .read(remindersControllerProvider)
                .markDone(reminder['id'] as String);
          } catch (_) {
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('Could not update — try again when online'),
                ),
              );
            }
          }
        },
      ),
    );
  }
}

class _PtpTile extends StatelessWidget {
  final Map<String, dynamic> ptp;
  final bool heroMode;
  const _PtpTile({required this.ptp, this.heroMode = false});

  @override
  Widget build(BuildContext context) {
    final promised = DateTime.parse(ptp['promised_date'] as String);
    // Date-only comparison -- comparing against DateTime.now() directly
    // (which carries a time-of-day) marked a PTP due *today* as overdue
    // from 00:00 onward.
    final today = DateTime.now();
    final overdue = promised.isBefore(DateTime(today.year, today.month, today.day));
    final amount = parseDouble(ptp['amount']);
    final textColor = heroMode ? AppColors.onPrimary : null;

    return ListTile(
      dense: true,
      leading: Icon(
        Icons.schedule,
        size: 18,
        color: heroMode
            ? AppColors.onPrimary.withValues(alpha: 0.8)
            : (overdue ? AppColors.error : AppColors.warning),
      ),
      title: Text(
        ptp['customer_name'] as String? ?? '',
        style: TextStyle(fontSize: 13, color: textColor),
      ),
      subtitle: Text(
        'PTP${amount != null ? ': ${_rupee.format(amount)}' : ''}'
        '${overdue ? ' · Overdue' : ''}',
        style: TextStyle(
          fontSize: 11,
          color: heroMode
              ? AppColors.onPrimary.withValues(alpha: 0.65)
              : (overdue ? AppColors.error : AppColors.textTertiary),
        ).tabular,
      ),
    );
  }
}
