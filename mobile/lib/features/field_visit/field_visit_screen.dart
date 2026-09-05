import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api/api_client.dart';
import '../../core/models/disposition_code.dart';
import '../../core/offline/disposition_usage_store.dart';
import '../../core/offline/offline_queue.dart';
import '../../core/theme/app_theme.dart';
import '../../core/ui/ui.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/utils/messaging.dart';
import '../today/today_provider.dart';
import '../worklist/customer_detail_provider.dart';
import '../worklist/worklist_provider.dart';

/// Result codes available to a field agent -- FV plus whatever codes were
/// tagged FV during the X1 fix's OC/FV duplication (I3: "their code list is
/// FV plus shared codes", already satisfied by a plain channel filter since
/// a genuinely shared code now exists as its own FV-tagged row).
List<DispositionCode> fvCodes(List<DispositionCode> codes) =>
    codes.where((c) => c.channel == 'FV').toList();

/// Which of the selected code's required fields are still missing (I5: a
/// code needing a date demands one before submit). No 'channel' step here,
/// unlike the old call_log_screen.dart's `missingSteps` -- mobile has
/// exactly one channel (I3), so there's nothing to pick.
List<String> missingLogVisitFields({
  required DispositionCode? code,
  required bool hasAmount,
  required bool hasDate,
  required bool hasMode,
  required bool hasReason,
  required bool hasNameRelation,
}) {
  if (code == null) return const ['trail code'];
  final missing = <String>[];
  if (code.needsAmount && !hasAmount) missing.add('amount');
  if (code.needsDate && !hasDate) missing.add('date');
  if (code.needsMode && !hasMode) missing.add('payment mode');
  if (code.needsReason && !hasReason) missing.add('reason');
  if (code.needsNameRelation && !hasNameRelation) missing.add('name/relation');
  return missing;
}

/// Groups codes by category (§5.1: "grouped pills"), each group internally
/// ordered most-used-first, and the groups themselves ordered by their own
/// most-used code so a frequently-used category surfaces first. Extracted
/// as a pure function -- both the grouping and the ordering are unit-tested
/// directly (test/field_visit_screen_test.dart) without touching Hive.
List<MapEntry<String, List<DispositionCode>>> groupCodesByCategory(
  List<DispositionCode> codes,
  Map<String, int> usageCounts,
) {
  final groups = <String, List<DispositionCode>>{};
  for (final c in codes) {
    final key = (c.category?.trim().isNotEmpty ?? false) ? c.category!.trim() : 'Other';
    groups.putIfAbsent(key, () => []).add(c);
  }
  final entries = groups.entries
      .map((e) => MapEntry(e.key, sortByUsage(e.value, (c) => c.id, usageCounts)))
      .toList();
  int topUsage(List<DispositionCode> group) =>
      group.isEmpty ? 0 : (usageCounts[group.first.id] ?? 0);
  entries.sort((a, b) => topUsage(b.value).compareTo(topUsage(a.value)));
  return entries;
}

/// Builds the `POST /call-logs` payload (I1, I2, §4.4) -- money is embedded
/// as a `payment` object only when the code actually represents a
/// collection, not a promise (`dispositionCreatesPtp`): a Promise to Pay's
/// "amount" is a *future* figure that creates a PTP via `fields`, not money
/// that changed hands today. Pure function so the payload shape (and X3's
/// fix -- the trail code always reaches `disposition_code_id`) has a direct
/// unit test independent of the widget tree.
Map<String, dynamic> buildLogVisitPayload({
  required String customerId,
  required DispositionCode code,
  required Map<String, dynamic> fields,
  required String extraRemark,
  required String clientKey,
}) {
  final isPromise = dispositionCreatesPtp(code);
  final amount = fields['amount'];
  return {
    'customer_id': customerId,
    'disposition_code_id': code.id,
    'fields': fields,
    if (extraRemark.trim().isNotEmpty) 'extra_remark': extraRemark.trim(),
    'client_key': clientKey,
    if (code.needsAmount && !isPromise && amount != null)
      'payment': {
        'amount': amount,
        if (fields['mode'] != null) 'mode': fields['mode'],
        if (fields['date'] != null) 'paid_at': fields['date'],
      },
  };
}

const _paymentModes = ['Cash', 'NEFT', 'RTGS', 'UPI', 'Cheque', 'DD'];

/// Phase 11 (I1-I6, §5.1): the merged Log Visit screen -- one form for a
/// field agent's entire interaction (trail code, embedded payment,
/// PTP-triggering date, remark), replacing three separate screens (the old
/// field-visit photo/GPS form, the standalone call-log 4-step flow, and the
/// standalone payment screen). Fixes X3: the outcome (now the trail code,
/// per I1 -- there is no second ad hoc outcome taxonomy any more) always
/// reaches the payload, by construction, since submission is blocked until
/// one is chosen.
///
/// Per §5.1's literal Log Visit component list, this screen no longer
/// captures a photo or GPS point (dropped along with the old met/no-access
/// outcome control) -- continuous background tracking (X2) already records
/// the agent's location every ~2 minutes while punched in, and I6 already
/// held photo proof to be non-mandatory in every case.
class FieldVisitScreen extends ConsumerStatefulWidget {
  final String customerId;
  const FieldVisitScreen({super.key, required this.customerId});

  @override
  ConsumerState<FieldVisitScreen> createState() => _FieldVisitScreenState();
}

class _FieldVisitScreenState extends ConsumerState<FieldVisitScreen> {
  final _amountCtrl = TextEditingController();
  final _dateCtrl = TextEditingController();
  final _reasonCtrl = TextEditingController();
  final _nameRelCtrl = TextEditingController();
  final _extraCtrl = TextEditingController();
  String? _mode;
  String? _selectedCodeId;
  bool _confirmedExceedsDue = false;
  bool _loading = false;
  String? _error;
  String _remarkPreview = '';
  Map<String, int> _usageCounts = const {};

  @override
  void initState() {
    super.initState();
    DispositionUsageStore.counts().then((counts) {
      if (mounted) setState(() => _usageCounts = counts);
    });
  }

  @override
  void dispose() {
    _amountCtrl.dispose();
    _dateCtrl.dispose();
    _reasonCtrl.dispose();
    _nameRelCtrl.dispose();
    _extraCtrl.dispose();
    super.dispose();
  }

  List<DispositionCode> get _allFvCodes {
    final raw = ref.read(dispositionCodesProvider).valueOrNull ?? const [];
    return fvCodes(raw.map(DispositionCode.fromJson).toList());
  }

  DispositionCode? get _selectedCode {
    final id = _selectedCodeId;
    if (id == null) return null;
    for (final c in _allFvCodes) {
      if (c.id == id) return c;
    }
    return null;
  }

  double? _parseAmount() => double.tryParse(_amountCtrl.text.replaceAll(',', '').trim());

  void _selectCode(String id) {
    setState(() {
      _selectedCodeId = _selectedCodeId == id ? null : id;
      _error = null;
      _confirmedExceedsDue = false;
    });
    _updatePreview();
  }

  void _applyAmountChip(double value) {
    setState(() {
      _amountCtrl.text = value == value.roundToDouble() ? value.toStringAsFixed(0) : value.toStringAsFixed(2);
      _confirmedExceedsDue = false;
    });
    _updatePreview();
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: now.subtract(const Duration(days: 1)),
      lastDate: now.add(const Duration(days: 90)),
    );
    if (picked != null) {
      _dateCtrl.text = DateFormat('yyyy-MM-dd').format(picked);
      _updatePreview();
    }
  }

  void _updatePreview() {
    final code = _selectedCode;
    if (code == null) {
      setState(() => _remarkPreview = '');
      return;
    }
    final parts = <String>[];
    if (code.needsAmount && _amountCtrl.text.isNotEmpty) parts.add('₹${_amountCtrl.text}');
    if (code.needsDate && _dateCtrl.text.isNotEmpty) parts.add(_dateCtrl.text);
    if (code.needsMode && _mode != null) parts.add(_mode!);
    if (code.needsReason && _reasonCtrl.text.isNotEmpty) parts.add(_reasonCtrl.text);
    if (code.needsNameRelation && _nameRelCtrl.text.isNotEmpty) parts.add(_nameRelCtrl.text);
    final extra = _extraCtrl.text.isNotEmpty ? ' — ${_extraCtrl.text}' : '';
    setState(() => _remarkPreview = parts.join(' | ') + extra);
  }

  Future<void> _showReceiptSheet(String receiptNo, double amount) async {
    final customer = ref.read(customerByIdProvider(widget.customerId)).valueOrNull;
    final mobileNumber = customer?.mobileNumber;
    final hasPhone = mobileNumber != null && mobileNumber.isNotEmpty;
    if (!mounted) return;
    await showModalBottomSheet(
      context: context,
      isDismissible: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.check_circle, color: AppColors.success, size: 48),
              const SizedBox(height: 8),
              const Text('Payment recorded', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              const SizedBox(height: 4),
              Text(receiptNo, textAlign: TextAlign.center, style: const TextStyle(fontSize: 14, color: AppColors.textSecondary).tabular),
              const SizedBox(height: 20),
              if (hasPhone) ...[
                AppSecondaryButton(
                  icon: Icons.chat,
                  label: 'Share receipt on WhatsApp',
                  onPressed: () => shareMessage(
                    context,
                    mobileNumber: mobileNumber,
                    viaWhatsApp: true,
                    message: 'Receipt $receiptNo\n₹${amount.toStringAsFixed(2)} received'
                        '${customer?.customerName != null ? ' from ${customer!.customerName}' : ''}.\n'
                        'Thank you — Rudrayani Fintech',
                  ),
                ),
                const SizedBox(height: 8),
                AppSecondaryButton(
                  icon: Icons.sms,
                  label: 'Share receipt via SMS',
                  onPressed: () => shareMessage(
                    context,
                    mobileNumber: mobileNumber,
                    viaWhatsApp: false,
                    message: 'Receipt $receiptNo\n₹${amount.toStringAsFixed(2)} received'
                        '${customer?.customerName != null ? ' from ${customer!.customerName}' : ''}.\n'
                        'Thank you — Rudrayani Fintech',
                  ),
                ),
                const SizedBox(height: 8),
              ],
              AppPrimaryButton(label: 'Done', onPressed: () => Navigator.of(sheetContext).pop()),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    final code = _selectedCode;
    final missing = missingLogVisitFields(
      code: code,
      hasAmount: _amountCtrl.text.isNotEmpty,
      hasDate: _dateCtrl.text.isNotEmpty,
      hasMode: _mode != null,
      hasReason: _reasonCtrl.text.isNotEmpty,
      hasNameRelation: _nameRelCtrl.text.isNotEmpty,
    );
    if (missing.isNotEmpty) {
      setState(() => _error = 'Please provide: ${missing.join(', ')}');
      return;
    }
    final selected = code!;
    final isPromise = dispositionCreatesPtp(selected);
    final amount = selected.needsAmount ? _parseAmount() : null;
    if (selected.needsAmount && amount == null) {
      setState(() => _error = 'Enter a valid amount');
      return;
    }

    if (!isPromise && amount != null) {
      final dueAmount = ref.read(customerByIdProvider(widget.customerId)).valueOrNull?.dueAmount;
      final exceedsDue = dueAmount != null && amount > dueAmount;
      if (exceedsDue && !_confirmedExceedsDue) {
        setState(() => _error = 'Confirm the amount above — it\'s more than what\'s owed');
        return;
      }
    }

    final fields = <String, dynamic>{};
    if (selected.needsAmount) fields['amount'] = amount;
    if (selected.needsDate) fields['date'] = _dateCtrl.text;
    if (selected.needsMode) fields['mode'] = _mode;
    if (selected.needsReason) fields['reason'] = _reasonCtrl.text.trim();
    if (selected.needsNameRelation) fields['name_relation'] = _nameRelCtrl.text.trim();

    final clientKey = OfflineQueueNotifier.newClientKey();
    final payload = buildLogVisitPayload(
      customerId: widget.customerId,
      code: selected,
      fields: fields,
      extraRemark: _extraCtrl.text,
      clientKey: clientKey,
    );

    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      Map<String, dynamic>? receiptPayment;
      try {
        final res = await api.post<Map<String, dynamic>>('/call-logs', data: payload);
        receiptPayment = res.data?['payment'] as Map<String, dynamic>?;
      } catch (e) {
        if (!isOfflineError(e)) rethrow;
        await ref.read(offlineQueueProvider.notifier).enqueue(QueuedAction(
              clientKey: clientKey,
              type: 'call_log',
              payload: payload,
              createdAt: DateTime.now(),
            ));
        if (mounted) {
          HapticFeedback.lightImpact();
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('No network — visit saved offline, will sync automatically'),
              backgroundColor: AppColors.warning,
            ),
          );
        }
        _finishAfterSave(collectedDelta: !isPromise ? amount : null);
        return;
      }

      await DispositionUsageStore.recordUse(selected.id);
      if (mounted) {
        HapticFeedback.mediumImpact();
        final receiptNo = receiptPayment?['receipt_no'] as String?;
        if (receiptNo != null && amount != null) {
          await _showReceiptSheet(receiptNo, amount);
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Visit logged!'), backgroundColor: AppColors.success),
          );
        }
      }
      _finishAfterSave(collectedDelta: !isPromise ? amount : null);
    } catch (e) {
      setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Common cleanup for both the online and offline-queued success paths:
  /// Phase 10's "greys and sinks without a full reload" -- update the
  /// already-loaded Today row directly rather than refetching -- plus
  /// invalidating the detail providers so Customer Detail reflects the new
  /// disposition/PTP when the agent pops back to it.
  void _finishAfterSave({double? collectedDelta}) {
    ref.read(todayWorklistProvider.notifier).markWorked(widget.customerId, collectedDelta: collectedDelta);
    ref.invalidate(customerByIdProvider(widget.customerId));
    ref.invalidate(customerDetailProvider(widget.customerId));
    if (mounted) context.pop();
  }

  @override
  Widget build(BuildContext context) {
    final codesAsync = ref.watch(dispositionCodesProvider);
    final customerAsync = ref.watch(customerByIdProvider(widget.customerId));
    final selectedCode = _selectedCode;
    final isPromise = selectedCode != null && dispositionCreatesPtp(selectedCode);
    final customer = customerAsync.valueOrNull;
    final dueAmount = customer?.dueAmount;
    final enteredAmount = _parseAmount();
    final exceedsDue =
        !isPromise && dueAmount != null && enteredAmount != null && enteredAmount > dueAmount;

    return AppScaffold(
      title: customerAsync.maybeWhen(data: (c) => 'Log Visit — ${c.customerName}', orElse: () => 'Log Visit'),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Amount (dominant) + mode pills (§5.1) -- always visible so the
            // agent can start with "how much did I collect" before picking
            // a trail code, rather than waiting on a code selection first.
            AppFormField(
              label: isPromise ? 'Promised Amount (₹)' : 'Amount Collected (₹)',
              controller: _amountCtrl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              prefixIcon: const Icon(Icons.currency_rupee),
              onChanged: (_) {
                setState(() => _confirmedExceedsDue = false);
                _updatePreview();
              },
            ),
            if (customer?.emi != null || customer?.dueAmount != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Wrap(
                spacing: AppSpacing.sm,
                children: [
                  if (customer?.emi != null && customer!.emi! > 0)
                    ActionChip(
                      label: Text('Full EMI ₹${customer.emi!.toStringAsFixed(0)}', style: const TextStyle().tabular),
                      onPressed: () => _applyAmountChip(customer.emi!),
                    ),
                  if (customer?.dueAmount != null && customer!.dueAmount! > 0)
                    ActionChip(
                      label: Text('Full Due ₹${customer.dueAmount!.toStringAsFixed(0)}', style: const TextStyle().tabular),
                      onPressed: () => _applyAmountChip(customer.dueAmount!),
                    ),
                ],
              ),
            ],
            if (exceedsDue) ...[
              const SizedBox(height: AppSpacing.sm),
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(color: AppColors.warningContainer, borderRadius: BorderRadius.circular(AppRadius.md)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'This is more than what\'s owed (₹${dueAmount.toStringAsFixed(0)} due). Double-check the amount.',
                      style: const TextStyle(fontSize: 12, color: AppColors.warningStrong).tabular,
                    ),
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      controlAffinity: ListTileControlAffinity.leading,
                      title: const Text('Yes, this amount is correct', style: TextStyle(fontSize: 13)),
                      value: _confirmedExceedsDue,
                      onChanged: (v) => setState(() => _confirmedExceedsDue = v ?? false),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            AppSectionHeader(title: 'Payment mode'),
            AppChipGroup<String>(
              options: [for (final m in _paymentModes) AppChipOption(value: m, label: m)],
              selected: _mode == null ? {} : {_mode!},
              onSelected: (m) {
                setState(() => _mode = _mode == m ? null : m);
                _updatePreview();
              },
            ),
            const SizedBox(height: AppSpacing.lg),

            // Trail code -- grouped pills, most-used first (§5.1, I1, I3).
            AppSectionHeader(title: 'Trail Code *'),
            codesAsync.when(
              loading: () => const AppLoadingState(),
              error: (e, _) => AppInlineErrorNote(
                message: 'Could not load trail codes: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(dispositionCodesProvider),
              ),
              data: (_) {
                final groups = groupCodesByCategory(_allFvCodes, _usageCounts);
                if (groups.isEmpty) {
                  return const AppInlineErrorNote(message: 'No trail codes configured for field visits yet');
                }
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final group in groups) ...[
                      Padding(
                        padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: AppSpacing.xs),
                        child: Text(
                          group.key,
                          style: Theme.of(context).textTheme.labelMedium?.copyWith(color: AppColors.textTertiary),
                        ),
                      ),
                      AppChipGroup<String>(
                        options: [for (final c in group.value) AppChipOption(value: c.id, label: c.display)],
                        selected: _selectedCodeId == null ? {} : {_selectedCodeId!},
                        onSelected: _selectCode,
                      ),
                    ],
                  ],
                );
              },
            ),

            if (selectedCode != null) ...[
              if (selectedCode.needsDate) ...[
                const SizedBox(height: AppSpacing.lg),
                // AppFormField has no onTap/readOnly -- a plain TextField
                // (border/label styling already comes from the app-wide
                // InputDecorationTheme, same as the Today screen's search
                // box) is the right tool for a tap-to-open-picker field.
                TextField(
                  controller: _dateCtrl,
                  readOnly: true,
                  decoration: InputDecoration(
                    labelText: isPromise ? 'Promised Date *' : 'Date *',
                    suffixIcon: const Icon(Icons.calendar_today),
                  ),
                  onTap: _pickDate,
                ),
              ],
              if (selectedCode.needsReason) ...[
                const SizedBox(height: AppSpacing.md),
                AppFormField(
                  label: 'Reason *',
                  controller: _reasonCtrl,
                  maxLines: 2,
                  onChanged: (_) => _updatePreview(),
                ),
              ],
              if (selectedCode.needsNameRelation) ...[
                const SizedBox(height: AppSpacing.md),
                AppFormField(
                  label: 'Name / Relation *',
                  controller: _nameRelCtrl,
                  onChanged: (_) => _updatePreview(),
                ),
              ],
            ],

            const SizedBox(height: AppSpacing.lg),
            AppSectionHeader(title: 'Remark'),
            AppFormField(
              label: 'Remark (optional)',
              controller: _extraCtrl,
              maxLines: 2,
              onChanged: (_) => _updatePreview(),
            ),
            if (_remarkPreview.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.sm),
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: AppColors.successContainer,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  border: Border.all(color: AppColors.success.withValues(alpha: 0.3)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Preview', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: AppColors.successStrong, fontWeight: FontWeight.bold)),
                    const SizedBox(height: AppSpacing.xs),
                    Text(_remarkPreview, style: const TextStyle(fontSize: 13).tabular),
                  ],
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.sm),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        minimum: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: Text(_error!, style: const TextStyle(color: AppColors.error)),
              ),
            AppPrimaryButton(
              label: _loading ? 'Saving…' : 'Save',
              icon: Icons.save,
              loading: _loading,
              onPressed: _loading ? null : _submit,
            ),
          ],
        ),
      ),
    );
  }
}
