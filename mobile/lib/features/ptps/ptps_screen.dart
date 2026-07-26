import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/widgets/state_views.dart';
import '../../core/utils/parser.dart';
import '../worklist/worklist_provider.dart';

final _rupee = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
final _date = DateFormat('dd MMM yyyy');

final ptpListProvider = FutureProvider.family<List<Map<String, dynamic>>, String>((ref, customerId) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get<Map<String, dynamic>>('/ptps', query: {'customer_id': customerId});
  return (res.data!['ptps'] as List).cast<Map<String, dynamic>>();
});

/// PTPs previously only came into existence as a side effect of logging a
/// call with a PTP-flavored disposition -- this is the first-class create/
/// edit/reschedule path the product never had.
class PtpsController {
  final Ref ref;
  PtpsController(this.ref);

  Future<void> create({
    required String customerId,
    required double amount,
    required DateTime promisedDate,
    String? mode,
  }) async {
    final api = ref.read(apiClientProvider);
    await api.post('/ptps', data: {
      'customer_id': customerId,
      'amount': amount,
      'promised_date': DateFormat('yyyy-MM-dd').format(promisedDate),
      if (mode != null) 'mode': mode,
    });
    ref.invalidate(ptpListProvider(customerId));
  }

  Future<void> update({
    required String customerId,
    required String ptpId,
    double? amount,
    DateTime? promisedDate,
    String? mode,
    String? status,
  }) async {
    final api = ref.read(apiClientProvider);
    await api.patch('/ptps/$ptpId', data: {
      if (amount != null) 'amount': amount,
      if (promisedDate != null) 'promised_date': DateFormat('yyyy-MM-dd').format(promisedDate),
      if (mode != null) 'mode': mode,
      if (status != null) 'status': status,
    });
    ref.invalidate(ptpListProvider(customerId));
  }
}

final ptpsControllerProvider = Provider((ref) => PtpsController(ref));

class PtpsScreen extends ConsumerWidget {
  final String customerId;
  const PtpsScreen({super.key, required this.customerId});

  Color _statusColor(String status) => switch (status) {
        'kept' => AppColors.success,
        'broken' => AppColors.error,
        _ => AppColors.warning,
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ptps = ref.watch(ptpListProvider(customerId));
    final customerAsync = ref.watch(customerByIdProvider(customerId));

    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.onPrimary,
        title: Text(
          customerAsync.maybeWhen(
            data: (c) => 'PTPs — ${c.customerName}',
            orElse: () => 'PTPs',
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(ptpListProvider(customerId)),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => showPtpFormSheet(context, ref, customerId: customerId),
        icon: const Icon(Icons.add),
        label: const Text('New PTP'),
      ),
      body: ptps.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorState(
          message: 'Could not load PTPs.\n$e',
          onRetry: () => ref.invalidate(ptpListProvider(customerId)),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyState(
              icon: Icons.calendar_today,
              message: 'No PTPs for this customer — tap "New PTP" to record one',
            );
          }
          return ListView.builder(
            padding: const EdgeInsets.all(12),
            itemCount: list.length,
            itemBuilder: (ctx, i) {
              final ptp = list[i];
              final status = ptp['status'] as String;
              final amount = parseDouble(ptp['amount']);
              final promised = ptp['promised_date'] != null
                  ? DateTime.parse(ptp['promised_date'] as String)
                  : null;
              // Date-only comparison -- comparing against DateTime.now()
              // directly (which carries a time-of-day) marked a PTP due
              // *today* as "Overdue" from 00:00 onward.
              final today = DateTime.now();
              final todayDateOnly = DateTime(today.year, today.month, today.day);
              final isOverdue = promised != null &&
                  status == 'pending' &&
                  promised.isBefore(todayDateOnly);

              return Card(
                margin: const EdgeInsets.only(bottom: 8),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: status == 'pending'
                      ? () => showPtpFormSheet(
                            context,
                            ref,
                            customerId: customerId,
                            existing: ptp,
                          )
                      : null,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: _statusColor(status).withAlpha(25),
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: _statusColor(status)),
                          ),
                          child: Text(
                            status.toUpperCase(),
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.bold,
                              color: _statusColor(status),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (amount != null)
                                Text(
                                  _rupee.format(amount),
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16).tabular,
                                ),
                              if (promised != null)
                                Text(
                                  'Due: ${_date.format(promised)}${isOverdue ? ' ⚠ Overdue' : ''}',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: isOverdue ? AppColors.error : AppColors.textTertiary,
                                  ).tabular,
                                ),
                              if (ptp['mode'] != null)
                                Text('Mode: ${ptp["mode"]}', style: const TextStyle(fontSize: 12)),
                            ],
                          ),
                        ),
                        if (status == 'pending') const Icon(Icons.chevron_right, color: AppColors.textTertiary),
                      ],
                    ),
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// Shared create/edit sheet. [existing] present = edit/reschedule/resolve an
/// already-pending PTP; absent = create a new one.
Future<void> showPtpFormSheet(
  BuildContext context,
  WidgetRef ref, {
  required String customerId,
  Map<String, dynamic>? existing,
}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (_) => _PtpFormSheet(customerId: customerId, existing: existing),
  );
}

class _PtpFormSheet extends ConsumerStatefulWidget {
  final String customerId;
  final Map<String, dynamic>? existing;
  const _PtpFormSheet({required this.customerId, this.existing});

  @override
  ConsumerState<_PtpFormSheet> createState() => _PtpFormSheetState();
}

class _PtpFormSheetState extends ConsumerState<_PtpFormSheet> {
  late final TextEditingController _amountCtrl;
  DateTime _date = DateTime.now();
  String? _mode;
  bool _saving = false;
  String? _error;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _amountCtrl = TextEditingController(text: parseDouble(e?['amount'])?.toStringAsFixed(0) ?? '');
    if (e?['promised_date'] != null) _date = DateTime.parse(e!['promised_date'] as String);
    _mode = e?['mode'] as String?;
  }

  @override
  void dispose() {
    _amountCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime.now().subtract(const Duration(days: 1)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _save() async {
    final amount = double.tryParse(_amountCtrl.text.replaceAll(',', ''));
    if (amount == null || amount <= 0) {
      setState(() => _error = 'Enter a valid promised amount');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final controller = ref.read(ptpsControllerProvider);
      if (_isEdit) {
        await controller.update(
          customerId: widget.customerId,
          ptpId: widget.existing!['id'] as String,
          amount: amount,
          promisedDate: _date,
          mode: _mode,
        );
      } else {
        await controller.create(
          customerId: widget.customerId,
          amount: amount,
          promisedDate: _date,
          mode: _mode,
        );
      }
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() => _error = 'Could not save: ${e.toString().replaceFirst('DioException', '').trim()}');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _resolve(String status) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref.read(ptpsControllerProvider).update(
            customerId: widget.customerId,
            ptpId: widget.existing!['id'] as String,
            status: status,
          );
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() => _error = 'Could not update: ${e.toString().replaceFirst('DioException', '').trim()}');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 20,
          bottom: 20 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              _isEdit ? 'Reschedule / Update PTP' : 'New Promise to Pay',
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _amountCtrl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              style: const TextStyle().tabular,
              decoration: const InputDecoration(
                labelText: 'Promised Amount (₹) *',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.currency_rupee),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              readOnly: true,
              controller: TextEditingController(text: _date.formatted),
              decoration: const InputDecoration(
                labelText: 'Promised Date *',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.calendar_today),
              ),
              onTap: _pickDate,
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _mode,
              decoration: const InputDecoration(
                labelText: 'Mode (optional)',
                border: OutlineInputBorder(),
              ),
              items: ['Cash', 'NEFT', 'RTGS', 'UPI', 'Cheque', 'DD']
                  .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                  .toList(),
              onChanged: (v) => setState(() => _mode = v),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: AppColors.error)),
            ],
            const SizedBox(height: 16),
            SizedBox(
              height: AppDimens.tapTarget,
              child: ElevatedButton(
                onPressed: _saving ? null : _save,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: AppColors.onPrimary,
                ),
                child: _saving
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.onPrimary),
                      )
                    : Text(_isEdit ? 'Save Changes' : 'Create PTP'),
              ),
            ),
            if (_isEdit) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _saving ? null : () => _resolve('kept'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.success,
                        minimumSize: const Size(0, AppDimens.tapTarget),
                      ),
                      child: const Text('Mark Kept'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _saving ? null : () => _resolve('broken'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.error,
                        minimumSize: const Size(0, AppDimens.tapTarget),
                      ),
                      child: const Text('Mark Broken'),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

extension on DateTime {
  String get formatted => _date.format(this);
}
