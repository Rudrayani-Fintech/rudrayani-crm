import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/utils/parser.dart';

const _modeOptions = ['NEFT', 'RTGS', 'Cash', 'UPI', 'Cheque', 'DD'];

/// "Report an error" — lets an agent flag a mistake on their own payment /
/// call-log / PTP for a TL/ops to review (POST /correction-requests).
/// Pre-filled with the record's current values; only fields the agent
/// actually changes are sent as proposed_changes.
Future<void> showCorrectionRequestDialog(
  BuildContext context,
  WidgetRef ref, {
  required String recordType,
  required String recordId,
  required Map<String, dynamic> currentValues,
  required VoidCallback onSubmitted,
}) async {
  final reasonCtrl = TextEditingController();
  final amountCtrl = TextEditingController(
    text: currentValues['amount']?.toString() ?? '',
  );
  final remarkCtrl = TextEditingController(
    text: currentValues['remark']?.toString() ?? '',
  );
  String? mode = currentValues['mode'] as String?;
  DateTime? date = () {
    final raw = (currentValues['paid_at'] ?? currentValues['promised_date'])
        ?.toString();
    if (raw == null) return null;
    try {
      return DateTime.parse(raw);
    } catch (_) {
      return null;
    }
  }();

  final result = await showDialog<bool>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => AlertDialog(
        title: const Text('Report an error'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'A team lead or ops will review this before anything changes.',
                style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 12),
              if (recordType == 'payment' || recordType == 'ptp') ...[
                TextField(
                  controller: amountCtrl,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  // Tabular-nums (MANDATORY, design brief) even while typing.
                  style: const TextStyle().tabular,
                  decoration: const InputDecoration(
                    labelText: 'Amount (₹)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
              ],
              if (recordType == 'payment') ...[
                DropdownButtonFormField<String>(
                  initialValue: mode,
                  decoration: const InputDecoration(
                    labelText: 'Mode',
                    border: OutlineInputBorder(),
                  ),
                  items: _modeOptions
                      .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                      .toList(),
                  onChanged: (v) => setState(() => mode = v),
                ),
                const SizedBox(height: 12),
              ],
              if (recordType == 'payment' || recordType == 'ptp') ...[
                InkWell(
                  onTap: () async {
                    final picked = await showDatePicker(
                      context: ctx,
                      initialDate: date ?? DateTime.now(),
                      firstDate: DateTime.now().subtract(
                        const Duration(days: 365),
                      ),
                      lastDate: DateTime.now().add(const Duration(days: 365)),
                    );
                    if (picked != null) setState(() => date = picked);
                  },
                  child: InputDecorator(
                    decoration: InputDecoration(
                      labelText: recordType == 'ptp'
                          ? 'Promised Date'
                          : 'Paid At',
                      border: const OutlineInputBorder(),
                    ),
                    child: Text(
                      date != null
                          ? DateFormat('dd MMM yyyy').format(date!)
                          : 'Not set',
                    ),
                  ),
                ),
                const SizedBox(height: 12),
              ],
              if (recordType == 'call_log' || recordType == 'field_visit') ...[
                TextField(
                  controller: remarkCtrl,
                  maxLines: 3,
                  decoration: const InputDecoration(
                    labelText: 'Remark',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
              ],
              TextField(
                controller: reasonCtrl,
                maxLines: 2,
                autofocus: true,
                decoration: const InputDecoration(
                  labelText: "What's wrong? *",
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Send for review'),
          ),
        ],
      ),
    ),
  );

  if (result != true || !context.mounted) return;
  if (reasonCtrl.text.trim().length < 3) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("Please explain what's wrong")),
    );
    return;
  }

  final proposedChanges = <String, dynamic>{};
  if (recordType == 'payment' || recordType == 'ptp') {
    final newAmount = double.tryParse(amountCtrl.text);
    if (newAmount != null &&
        newAmount != parseDouble(currentValues['amount'])) {
      proposedChanges['amount'] = newAmount;
    }
  }
  if (recordType == 'payment' && mode != currentValues['mode']) {
    proposedChanges['mode'] = mode;
  }
  if ((recordType == 'payment' || recordType == 'ptp') && date != null) {
    final dateField = recordType == 'ptp' ? 'promised_date' : 'paid_at';
    final formatted = DateFormat('yyyy-MM-dd').format(date!);
    final currentRaw = currentValues[dateField]?.toString();
    final currentFormatted = currentRaw != null
        ? DateFormat('yyyy-MM-dd').format(DateTime.parse(currentRaw))
        : null;
    if (formatted != currentFormatted) proposedChanges[dateField] = formatted;
  }
  if ((recordType == 'call_log' || recordType == 'field_visit') &&
      remarkCtrl.text.trim() != (currentValues['remark']?.toString() ?? '')) {
    proposedChanges['remark'] = remarkCtrl.text.trim();
  }

  if (proposedChanges.isEmpty) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Change at least one field, or there\'s nothing to correct'),
        ),
      );
    }
    return;
  }

  try {
    await ref
        .read(apiClientProvider)
        .post(
          '/correction-requests',
          data: {
            'record_type': recordType,
            'record_id': recordId,
            'proposed_changes': proposedChanges,
            'reason': reasonCtrl.text.trim(),
          },
        );
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Correction request sent for review'),
          backgroundColor: AppColors.success,
        ),
      );
    }
    onSubmitted();
  } on DioException catch (e) {
    if (context.mounted) {
      final msg =
          e.response?.data is Map && (e.response?.data as Map)['error'] != null
          ? (e.response!.data as Map)['error'].toString()
          : 'Could not send the request — check your connection';
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(msg), backgroundColor: AppColors.error));
    }
  }
}
