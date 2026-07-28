import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'correction_request_dialog.dart';
import 'customer_detail_provider.dart';
import '../../../core/utils/parser.dart';
import '../../core/utils/money.dart' as money;

String _rupee(num? v) => money.rupees(v);
final _dateTime = DateFormat('dd MMM yyyy, HH:mm');

class _HistoryEntry {
  final DateTime at;
  final IconData icon;
  final Color color;
  final String title;
  final String? subtitle;
  // Only set for entries a correction request can be filed against
  // (payment / call_log / ptp) — field_visits and attachments have no
  // correction flow.
  final String? correctableRecordType;
  final String? recordId;
  final Map<String, dynamic>? rawFields;
  const _HistoryEntry({
    required this.at,
    required this.icon,
    required this.color,
    required this.title,
    this.subtitle,
    this.correctableRecordType,
    this.recordId,
    this.rawFields,
  });
}

List<_HistoryEntry> _merge(Map<String, dynamic> detail) {
  final entries = <_HistoryEntry>[];

  for (final t in (detail['trail'] as List? ?? [])) {
    final m = t as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['created_at'] as String),
        icon: Icons.phone_in_talk,
        color: AppColors.info,
        title:
            [
              m['result_code'],
              m['action_code'],
            ].where((v) => v != null).join(' · ').isEmpty
            ? 'Call logged'
            : [
                m['result_code'],
                m['action_code'],
              ].where((v) => v != null).join(' · '),
        subtitle: [
          m['agent_name'],
          m['remark'],
        ].whereType<String>().where((v) => v.isNotEmpty).join(' — '),
        correctableRecordType: 'call_log',
        recordId: m['id'] as String?,
        rawFields: {'remark': m['remark']},
      ),
    );
  }
  for (final p in (detail['payments'] as List? ?? [])) {
    final m = p as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['paid_at'] as String),
        icon: Icons.currency_rupee,
        color: AppColors.success,
        title: 'Payment: ${_rupee(parseDouble(m['amount']) ?? 0.0)}',
        subtitle: m['mode'] as String?,
        correctableRecordType: 'payment',
        recordId: m['id'] as String?,
        rawFields: {
          'amount': m['amount'],
          'mode': m['mode'],
          'paid_at': m['paid_at'],
        },
      ),
    );
  }
  for (final v in (detail['field_visits'] as List? ?? [])) {
    final m = v as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['created_at'] as String),
        icon: Icons.location_on,
        color: AppColors.warning,
        title: 'Field visit${m['has_photo'] == true ? ' (photo)' : ''}',
        subtitle: [
          m['agent_name'],
          m['remark'],
        ].whereType<String>().where((v) => v.isNotEmpty).join(' — '),
      ),
    );
  }
  for (final p in (detail['ptps'] as List? ?? [])) {
    final m = p as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['created_at'] as String),
        icon: Icons.calendar_today,
        color: AppColors.accent,
        title:
            'PTP: ${_rupee(parseDouble(m['amount']) ?? 0.0)} '
            '(${m['status']})',
        subtitle: m['promised_date'] != null
            ? 'Promised ${DateFormat('dd MMM yyyy').format(DateTime.parse(m['promised_date'] as String))}'
            : null,
        correctableRecordType: 'ptp',
        recordId: m['id'] as String?,
        rawFields: {'amount': m['amount'], 'promised_date': m['promised_date']},
      ),
    );
  }
  for (final a in (detail['attachments'] as List? ?? [])) {
    final m = a as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['created_at'] as String),
        icon: m['kind'] == 'document' ? Icons.picture_as_pdf : Icons.image,
        color: AppColors.primary,
        title: 'Document: ${m['file_name']}',
        subtitle: m['uploaded_by_name'] as String?,
      ),
    );
  }

  entries.sort((a, b) => b.at.compareTo(a.at));
  return entries.take(50).toList();
}

/// Full customer-360 timeline (calls, payments, field visits, PTPs,
/// documents) merged and sorted newest-first. Degrades gracefully offline —
/// the caller's other cards (loan details, last disposition, active PTP)
/// read from the worklist payload and keep rendering regardless.
class HistoryTimeline extends ConsumerWidget {
  final String customerId;
  const HistoryTimeline({super.key, required this.customerId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(customerDetailProvider(customerId));

    return Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'History',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                    color: AppColors.primary,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.refresh, size: 18),
                  onPressed: () =>
                      ref.invalidate(customerDetailProvider(customerId)),
                ),
              ],
            ),
            const Divider(),
            // Track 7.1: Customer context header (due amount, EMI)
            detail.maybeWhen(
              data: (d) {
                final dueAmount = d['due_amount'] as num?;
                final emi = d['emi'] as num?;
                if (dueAmount == null && emi == null) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      if (dueAmount != null) ...[
                        Text(
                          'Due: ${_rupee(dueAmount)}',
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        if (emi != null) const SizedBox(width: 16),
                      ],
                      if (emi != null)
                        Text(
                          'EMI: ${_rupee(emi)}',
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                    ],
                  ),
                );
              },
              orElse: () => const SizedBox.shrink(),
            ),
            const Divider(),
            detail.when(
              loading: () => const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: LinearProgressIndicator(),
              ),
              error: (e, _) => const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  'History unavailable offline',
                  style: TextStyle(fontSize: 12, color: AppColors.textTertiary),
                ),
              ),
              data: (d) {
                final entries = _merge(d);
                if (entries.isEmpty) {
                  return const Padding(
                    padding: EdgeInsets.symmetric(vertical: 8),
                    child: Text(
                      'No history yet',
                      style: TextStyle(fontSize: 12, color: AppColors.textTertiary),
                    ),
                  );
                }
                return Column(
                  children: entries
                      .map(
                        (e) => ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(e.icon, size: 18, color: e.color),
                          title: Text(
                            e.title,
                            style: const TextStyle(fontSize: 13).tabular,
                          ),
                          subtitle: Text(
                            [
                              _dateTime.format(e.at.toLocal()),
                              if (e.subtitle != null && e.subtitle!.isNotEmpty)
                                e.subtitle,
                            ].join(' — '),
                            style: const TextStyle(
                              fontSize: 11,
                              color: AppColors.textTertiary,
                            ).tabular,
                          ),
                          trailing: e.correctableRecordType != null
                              ? IconButton(
                                  icon: const Icon(Icons.flag_outlined, size: 18),
                                  tooltip: 'Report an error',
                                  onPressed: () => showCorrectionRequestDialog(
                                    context,
                                    ref,
                                    recordType: e.correctableRecordType!,
                                    recordId: e.recordId!,
                                    currentValues: e.rawFields!,
                                    onSubmitted: () =>
                                        ref.invalidate(customerDetailProvider(customerId)),
                                  ),
                                )
                              : null,
                        ),
                      )
                      .toList(),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
