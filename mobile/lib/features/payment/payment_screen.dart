import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../../core/theme/app_theme.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/models/customer.dart';
import '../../core/offline/offline_queue.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/utils/messaging.dart';
import '../worklist/worklist_provider.dart';

class PaymentScreen extends ConsumerStatefulWidget {
  final String customerId;
  const PaymentScreen({super.key, required this.customerId});

  @override
  ConsumerState<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends ConsumerState<PaymentScreen> {
  final _amountCtrl = TextEditingController();
  final _dateCtrl = TextEditingController();
  String? _mode;
  // Phase 12 (Management Dashboard "Settlement vs EMI Collections" KPI):
  // captured at collection time, defaults to the overwhelmingly common case.
  String _type = 'emi';
  File? _photo;
  bool _closeCustomer = false;
  bool _loading = false;
  String? _error;
  // Amounts above what's owed are never blocked (per product decision) — just
  // requires a deliberate acknowledgement so a typo'd extra zero doesn't slip
  // through silently.
  bool _confirmedExceedsDue = false;

  @override
  void dispose() {
    _amountCtrl.dispose();
    _dateCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickPhoto(ImageSource source) async {
    final picker = ImagePicker();
    final xfile = await picker.pickImage(source: source, imageQuality: 80, maxWidth: 1920);
    if (xfile != null) setState(() => _photo = File(xfile.path));
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: now.subtract(const Duration(days: 30)),
      lastDate: now,
    );
    if (picked != null) _dateCtrl.text = DateFormat('yyyy-MM-dd').format(picked);
  }

  /// Strips thousand-separator commas (e.g. from a pasted "1,000") before
  /// parsing -- double.tryParse rejects them outright otherwise.
  double? _parseAmount(String text) => double.tryParse(text.replaceAll(',', '').trim());

  Future<void> _confirmCloseCustomer() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Mark customer as Closed?'),
        content: const Text(
          'This clears the assignment and sets the loan status to closed. This cannot be undone from here.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Yes, close'),
          ),
        ],
      ),
    );
    if (mounted && confirmed == true) setState(() => _closeCustomer = true);
  }

  void _applyAmountChip(double value) {
    setState(() {
      _amountCtrl.text = value == value.roundToDouble()
          ? value.toStringAsFixed(0)
          : value.toStringAsFixed(2);
      _confirmedExceedsDue = false;
    });
  }

  Future<void> _submit() async {
    if (_amountCtrl.text.isEmpty) { setState(() => _error = 'Amount is required'); return; }
    final amount = _parseAmount(_amountCtrl.text);
    if (amount == null || amount <= 0) { setState(() => _error = 'Enter a valid positive amount'); return; }

    final dueAmount = ref.read(customerByIdProvider(widget.customerId)).valueOrNull?.dueAmount;
    final exceedsDue = dueAmount != null && amount > dueAmount;
    if (exceedsDue && !_confirmedExceedsDue) {
      setState(() => _error = 'Confirm the amount above — it\'s more than what\'s owed');
      return;
    }

    setState(() { _loading = true; _error = null; });
    try {
      final api = ref.read(apiClientProvider);
      // One key for both paths: a lost response must not double-record money.
      final payload = <String, dynamic>{
        'customer_id': widget.customerId,
        'amount': amount,
        'type': _type,
        if (_mode != null) 'mode': _mode,
        if (_dateCtrl.text.isNotEmpty) 'paid_at': _dateCtrl.text,
        'close_customer': _closeCustomer.toString(),
        'client_key': OfflineQueueNotifier.newClientKey(),
      };
      final form = FormData.fromMap({
        ...payload,
        if (_photo != null)
          'photo': await MultipartFile.fromFile(_photo!.path,
              filename: 'proof.jpg', contentType: DioMediaType('image', 'jpeg')),
      });

      String? receiptNo;
      try {
        final res = await api.postForm('/payments', form);
        receiptNo = (res.data['payment'] as Map<String, dynamic>?)?['receipt_no'] as String?;
      } catch (e) {
        if (!isOfflineError(e)) rethrow;
        // No network — persist the photo outside the picker cache and queue.
        final photoPath =
            _photo != null ? await OfflineQueueNotifier.persistPhoto(_photo!.path) : null;
        await ref.read(offlineQueueProvider.notifier).enqueue(QueuedAction(
              clientKey: payload['client_key'] as String,
              type: 'payment',
              payload: payload,
              photoPath: photoPath,
              createdAt: DateTime.now(),
            ));
        if (mounted) {
          // Lighter than the confirmed-recorded haptic below -- captured,
          // but not yet actually money-in-the-bank confirmed by the server.
          HapticFeedback.lightImpact();
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('No network — payment saved offline, will sync automatically'),
              backgroundColor: AppColors.warning,
            ),
          );
          context.pop();
          if (_closeCustomer) context.pop();
        }
        return;
      }

      if (mounted) {
        ref.invalidate(worklistProvider);
        ref.invalidate(dispositionCodesProvider);
        // On a noisy street a SnackBar alone is easy to miss entirely --
        // this is the one moment in the app where the agent most needs to
        // *feel* that money was actually recorded, not just glance at it.
        HapticFeedback.mediumImpact();
        // A receipt number only exists once the server has actually
        // inserted the row (never true on the offline-queue path above) --
        // previously the flow ended here with just a SnackBar and nothing
        // to hand the customer, despite the mobile dashboard already
        // labelling a KPI "Receipts Generated" for an artifact that never
        // existed.
        if (receiptNo != null) {
          final customer = ref.read(customerByIdProvider(widget.customerId)).valueOrNull;
          await _showReceiptSheet(receiptNo: receiptNo, amount: amount, customer: customer);
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Payment recorded!'), backgroundColor: AppColors.success),
          );
        }
        if (mounted) {
          context.pop();
          if (_closeCustomer) context.pop(); // also pop customer detail
        }
      }
    } catch (e) {
      setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _shareReceipt({
    required String receiptNo,
    required double amount,
    required String? customerName,
    required String? mobileNumber,
    required bool viaWhatsApp,
  }) async {
    if (mobileNumber == null) return;
    final message = 'Receipt $receiptNo\n'
        '₹${amount.toStringAsFixed(2)} received'
        '${customerName != null ? ' from $customerName' : ''}.\n'
        'Thank you — Rudrayani Fintech';
    await shareMessage(context, mobileNumber: mobileNumber, message: message, viaWhatsApp: viaWhatsApp);
  }

  Future<void> _showReceiptSheet({
    required String receiptNo,
    required double amount,
    required Customer? customer,
  }) {
    final mobileNumber = customer?.mobileNumber;
    final hasPhone = mobileNumber != null && mobileNumber.isNotEmpty;
    return showModalBottomSheet(
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
              Text(
                receiptNo,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 14, color: AppColors.textSecondary).tabular,
              ),
              const SizedBox(height: 20),
              if (hasPhone) ...[
                SizedBox(
                  height: AppDimens.tapTarget,
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.chat),
                    label: const Text('Share receipt on WhatsApp'),
                    onPressed: () => _shareReceipt(
                      receiptNo: receiptNo,
                      amount: amount,
                      customerName: customer?.customerName,
                      mobileNumber: mobileNumber,
                      viaWhatsApp: true,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  height: AppDimens.tapTarget,
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.sms),
                    label: const Text('Share receipt via SMS'),
                    onPressed: () => _shareReceipt(
                      receiptNo: receiptNo,
                      amount: amount,
                      customerName: customer?.customerName,
                      mobileNumber: mobileNumber,
                      viaWhatsApp: false,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
              ],
              SizedBox(
                height: AppDimens.tapTarget,
                child: ElevatedButton(
                  onPressed: () => Navigator.of(sheetContext).pop(),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: AppColors.onPrimary,
                  ),
                  child: const Text('Done'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final customerAsync = ref.watch(customerByIdProvider(widget.customerId));
    final customer = customerAsync.valueOrNull;
    final dueAmount = customer?.dueAmount;
    final emi = customer?.emi;
    final enteredAmount = _parseAmount(_amountCtrl.text);
    final exceedsDue = dueAmount != null && enteredAmount != null && enteredAmount > dueAmount;
    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.onPrimary,
        title: Text(
          customerAsync.maybeWhen(
            data: (c) => 'Record Payment — ${c.customerName}',
            orElse: () => 'Record Payment',
          ),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _amountCtrl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              // Tabular-nums (MANDATORY, design brief) even while typing.
              style: const TextStyle().tabular,
              decoration: const InputDecoration(
                labelText: 'Amount Collected (₹) *',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.currency_rupee),
              ),
              onChanged: (_) => setState(() => _confirmedExceedsDue = false),
            ),
            if (emi != null || dueAmount != null) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  if (emi != null && emi > 0)
                    ActionChip(
                      label: Text('Full EMI ₹${emi.toStringAsFixed(0)}', style: const TextStyle().tabular),
                      onPressed: () => _applyAmountChip(emi),
                    ),
                  if (dueAmount != null && dueAmount > 0)
                    ActionChip(
                      label: Text('Full Due ₹${dueAmount.toStringAsFixed(0)}', style: const TextStyle().tabular),
                      onPressed: () => _applyAmountChip(dueAmount),
                    ),
                ],
              ),
            ],
            if (exceedsDue) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.warningContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
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
                      title: const Text(
                        'Yes, this amount is correct',
                        style: TextStyle(fontSize: 13),
                      ),
                      value: _confirmedExceedsDue,
                      onChanged: (v) => setState(() => _confirmedExceedsDue = v ?? false),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _mode,
              decoration: const InputDecoration(
                labelText: 'Payment Mode',
                border: OutlineInputBorder(),
              ),
              items: ['Cash', 'NEFT', 'RTGS', 'UPI', 'Cheque', 'DD']
                  .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                  .toList(),
              onChanged: (v) => setState(() => _mode = v),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _type,
              decoration: const InputDecoration(
                labelText: 'Collection Type',
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 'emi', child: Text('EMI Collection')),
                DropdownMenuItem(value: 'settlement', child: Text('Settlement')),
              ],
              onChanged: (v) => setState(() => _type = v ?? 'emi'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _dateCtrl,
              readOnly: true,
              decoration: const InputDecoration(
                labelText: 'Payment Date',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.calendar_today),
                hintText: 'Today if blank',
              ),
              onTap: _pickDate,
            ),
            const SizedBox(height: 16),
            // Photo proof
            const Text('Photo Proof', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            const SizedBox(height: 8),
            if (_photo != null) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.file(_photo!, height: 200, fit: BoxFit.cover),
              ),
              const SizedBox(height: 8),
              TextButton.icon(
                icon: const Icon(Icons.delete),
                label: const Text('Remove photo'),
                onPressed: () => setState(() => _photo = null),
                style: TextButton.styleFrom(foregroundColor: AppColors.error),
              ),
            ] else ...[
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.camera_alt),
                      label: const Text('Camera'),
                      onPressed: () => _pickPhoto(ImageSource.camera),
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, AppDimens.tapTarget)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.photo_library),
                      label: const Text('Gallery'),
                      onPressed: () => _pickPhoto(ImageSource.gallery),
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, AppDimens.tapTarget)),
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 16),
            // Close customer toggle
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Mark customer as Closed'),
              subtitle: const Text('Clears assignment and sets status to closed', style: TextStyle(fontSize: 12)),
              value: _closeCustomer,
              onChanged: (v) {
                if (v) {
                  _confirmCloseCustomer();
                } else {
                  setState(() => _closeCustomer = false);
                }
              },
              activeThumbColor: AppColors.primary,
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
      // Persistent save bar (design brief 3.7) -- previously the primary
      // action sat at the bottom of a SingleChildScrollView, costing a
      // scroll past photo proof + the close-customer toggle on every payment.
      bottomNavigationBar: SafeArea(
        minimum: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(_error!, style: const TextStyle(color: AppColors.error)),
              ),
            SizedBox(
              height: AppDimens.tapTarget,
              width: double.infinity,
              child: ElevatedButton.icon(
                icon: _loading
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.onPrimary))
                    : const Icon(Icons.save),
                label: Text(_loading ? 'Saving…' : 'Record Payment'),
                onPressed: _loading ? null : _submit,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: AppColors.onPrimary,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
