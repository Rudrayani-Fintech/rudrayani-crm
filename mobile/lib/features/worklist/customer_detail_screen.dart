import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/api/api_client.dart';
import '../../core/models/customer.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/utils/messaging.dart';
import '../../core/widgets/state_views.dart';
import '../../core/utils/money.dart' as money;
import '../attachments/attachments_section.dart';
import '../reminders/reminder_sheet.dart';
import 'customer_detail_provider.dart';
import 'history_timeline.dart';
import 'worklist_provider.dart';

String _rupee(num? v) => money.rupees(v);

/// Import column headers arrive as raw keys (e.g. "customer_dob",
/// "PAN-number") — turn them into a readable label instead of showing the
/// source spreadsheet's column name verbatim.
String _formatFieldLabel(String key) {
  final words = key.split(RegExp(r'[_\-\s]+')).where((w) => w.isNotEmpty);
  return words
      .map((w) => w[0].toUpperCase() + w.substring(1).toLowerCase())
      .join(' ');
}

/// Resolves the customer by id before rendering — the screen navigates by
/// id only (not the whole Customer object) so it survives an app restart or
/// a cold deep link into `/customer/:id`.
class CustomerDetailScreen extends ConsumerWidget {
  final String customerId;

  const CustomerDetailScreen({super.key, required this.customerId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final customerAsync = ref.watch(customerByIdProvider(customerId));
    return customerAsync.when(
      data: (customer) => _CustomerDetailBody(customer: customer),
      loading: () => Scaffold(
        appBar: AppBar(
          backgroundColor: AppColors.primary,
          foregroundColor: AppColors.onPrimary,
        ),
        body: const Center(child: CircularProgressIndicator()),
      ),
      error: (err, _) => Scaffold(
        appBar: AppBar(
          backgroundColor: AppColors.primary,
          foregroundColor: AppColors.onPrimary,
        ),
        body: ErrorState(
          message: 'Could not load this customer.\n${friendlyError(err)}',
          onRetry: () => ref.invalidate(customerByIdProvider(customerId)),
        ),
      ),
    );
  }
}

class _CustomerDetailBody extends ConsumerWidget {
  final Customer customer;

  const _CustomerDetailBody({required this.customer});

  Future<void> _dial(BuildContext context) async {
    final uri = Uri(scheme: 'tel', path: customer.mobileNumber);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Cannot open dialer')));
      }
    }
  }

  /// The address arrives through the import's custom fields — find the
  /// first address-looking column and hand it to the maps app.
  String? get _address {
    for (final e in customer.customFields.entries) {
      final k = e.key.toLowerCase();
      if ((k.contains('address') || k.contains('addr')) &&
          (e.value?.toString().trim().isNotEmpty ?? false)) {
        return e.value.toString().trim();
      }
    }
    return null;
  }

  Future<void> _navigate(BuildContext context) async {
    final address = _address;
    if (address == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No address on file for this customer')),
      );
      return;
    }
    final uri = Uri.parse('geo:0,0?q=${Uri.encodeComponent(address)}');
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('No maps app available')));
      }
    }
  }

  /// Composes a payment-reminder message from whatever's on hand (active
  /// PTP first, else the plain due amount) and lets the agent send it
  /// straight to the customer -- WhatsApp is the primary channel in Indian
  /// collections and was entirely absent from the app until now.
  Future<void> _sendPaymentReminder(BuildContext context, bool viaWhatsApp) async {
    final greeting = 'Hi ${customer.customerName},';
    final String body;
    if (customer.ptpDate != null) {
      final due = DateFormat('dd MMM yyyy').format(customer.ptpDate!.toLocal());
      body = customer.ptpAmount != null
          ? 'this is a reminder of your promised payment of ${_rupee(customer.ptpAmount)} by $due.'
          : 'this is a reminder of your promised payment by $due.';
    } else if (customer.dueAmount != null && customer.dueAmount! > 0) {
      body = 'this is a reminder that ${_rupee(customer.dueAmount)} is due on your loan '
          '${customer.loanNumber}. Please arrange payment at the earliest.';
    } else {
      body = 'this is a reminder regarding your loan ${customer.loanNumber}. Please get in touch at your earliest convenience.';
    }
    await shareMessage(
      context,
      mobileNumber: customer.mobileNumber,
      viaWhatsApp: viaWhatsApp,
      message: '$greeting $body\nThank you — Rudrayani Fintech',
    );
  }

  Future<void> _requestReallocation(BuildContext context, WidgetRef ref) async {
    final reasonCtrl = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Request Reallocation'),
        content: TextField(
          controller: reasonCtrl,
          maxLines: 3,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Why should this customer be moved? *',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, reasonCtrl.text.trim()),
            child: const Text('Submit'),
          ),
        ],
      ),
    );
    if (reason == null) return; // Cancelled -- no feedback needed.
    if (reason.length < 3) {
      // Previously discarded silently -- the agent typed "no" or similar,
      // tapped Submit, and the dialog just closed with nothing sent and no
      // indication why.
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Please explain why in a few more words')),
        );
      }
      return;
    }

    try {
      await ref
          .read(apiClientProvider)
          .post(
            '/reallocation-requests',
            data: {'customer_id': customer.id, 'reason': reason},
          );
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Request sent — your team leader will review it'),
            backgroundColor: AppColors.success,
          ),
        );
      }
    } on DioException catch (e) {
      if (context.mounted) {
        final msg = e.response?.statusCode == 409
            ? 'A request is already pending for this customer'
            : friendlyError(e);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg), backgroundColor: AppColors.error),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.onPrimary,
        title: Text(customer.customerName),
        actions: [
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'realloc') _requestReallocation(context, ref);
            },
            itemBuilder: (ctx) => const [
              PopupMenuItem(
                value: 'realloc',
                child: ListTile(
                  leading: Icon(Icons.swap_horiz),
                  title: Text('Request Reallocation'),
                  contentPadding: EdgeInsets.zero,
                ),
              ),
            ],
          ),
        ],
      ),
      body: RefreshIndicator(
        // X4 fix: this used to invalidate only customerDetailProvider (the
        // History timeline's customer-360 fetch), while the header/loan
        // details/PTP cards above render from customerByIdProvider -- pull
        // to refresh looked like it worked (the spinner ran) but the header
        // never actually updated. Invalidate both, so refresh does what it
        // visibly promises.
        onRefresh: () async {
          ref.invalidate(customerByIdProvider(customer.id));
          ref.invalidate(customerDetailProvider(customer.id));
        },
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Call & action buttons
              Row(
                children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      icon: const Icon(Icons.call),
                      label: Text(
                        customer.mobileNumber.isNotEmpty
                            ? customer.mobileNumber
                            : 'No Number',
                      ),
                      onPressed: customer.mobileNumber.isNotEmpty
                          ? () => _dial(context)
                          : null,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.success,
                        foregroundColor: AppColors.onPrimary,
                        disabledBackgroundColor: AppColors.border,
                        disabledForegroundColor: AppColors.textTertiary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.note_add),
                      label: const Text('Log Call'),
                      onPressed: () =>
                          context.push('/customer/${customer.id}/call-log'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.payment),
                      label: const Text('Record Payment'),
                      onPressed: () =>
                          context.push('/customer/${customer.id}/payment'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.calendar_today),
                      label: const Text('View PTPs'),
                      onPressed: () =>
                          context.push('/customer/${customer.id}/ptps'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.assignment_turned_in),
                      label: const Text('Field Visit'),
                      onPressed: () => context
                          .push('/customer/${customer.id}/field-visit'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.directions),
                      label: const Text('Navigate'),
                      onPressed: () => _navigate(context),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.notifications_active_outlined),
                      label: const Text('Set Reminder'),
                      onPressed: () =>
                          showReminderSheet(context, ref, customer: customer),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.chat_outlined),
                      label: const Text('Send Reminder'),
                      onPressed: customer.mobileNumber.isNotEmpty
                          ? () => showModalBottomSheet(
                                context: context,
                                builder: (_) => SafeArea(
                                  child: Wrap(
                                    children: [
                                      ListTile(
                                        leading: const Icon(Icons.chat, color: AppColors.success),
                                        title: const Text('Send via WhatsApp'),
                                        onTap: () {
                                          Navigator.of(context).pop();
                                          _sendPaymentReminder(context, true);
                                        },
                                      ),
                                      ListTile(
                                        leading: const Icon(Icons.sms),
                                        title: const Text('Send via SMS'),
                                        onTap: () {
                                          Navigator.of(context).pop();
                                          _sendPaymentReminder(context, false);
                                        },
                                      ),
                                    ],
                                  ),
                                ),
                              )
                          : null,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              if (customer.normalizedPending)
                Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.info.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: AppColors.info.withValues(alpha: 0.3),
                    ),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.info_outline, size: 16, color: AppColors.info),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Normalized this month, pending lender confirmation. The lender\'s bucket stays authoritative until their next file confirms it.',
                          style: TextStyle(fontSize: 12, color: AppColors.info),
                        ),
                      ),
                    ],
                  ),
                ),
              // Loan details card
              _SectionCard(
                title: 'Loan Details',
                children: [
                  _Row('Loan Number', customer.loanNumber),
                  _Row('Company', customer.companyName),
                  if (customer.product != null)
                    _Row('Product', customer.product!),
                  if (customer.bucket != null) _Row('Bucket', customer.bucket!),
                  if (customer.dueAmount != null)
                    _Row(
                      'Due Amount',
                      _rupee(customer.dueAmount),
                      isMonetary: true,
                    ),
                  if (customer.emi != null)
                    _Row('EMI', _rupee(customer.emi), isMonetary: true),
                ],
              ),
              const SizedBox(height: 12),
              // Last disposition
              if (customer.lastRemark != null)
                _SectionCard(
                  title: 'Last Disposition',
                  children: [
                    if (customer.lastResultCode != null)
                      _Row('Result', customer.lastResultCode!),
                    if (customer.lastCallAt != null)
                      _Row(
                        'When',
                        DateFormat(
                          'dd MMM yyyy HH:mm',
                        ).format(customer.lastCallAt!.toLocal()),
                      ),
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Text(
                        customer.lastRemark!,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  ],
                ),
              // PTP reminder
              if (customer.ptpDate != null)
                _SectionCard(
                  title: 'Active PTP',
                  children: [
                    _Row(
                      'Amount',
                      _rupee(customer.ptpAmount),
                      isMonetary: true,
                    ),
                    _Row(
                      'Promised Date',
                      // Missing .toLocal() here (unlike lastCallAt above)
                      // rendered an evening-IST PTP one day early when the
                      // server sends a UTC instant.
                      DateFormat('dd MMM yyyy').format(customer.ptpDate!.toLocal()),
                    ),
                  ],
                ),
              // Custom fields
              if (customer.customFields.isNotEmpty)
                _SectionCard(
                  title: 'Additional Fields',
                  children: [
                    for (final e in customer.customFields.entries)
                      _Row(_formatFieldLabel(e.key), e.value?.toString() ?? '—'),
                  ],
                ),
              const SizedBox(height: 12),
              AttachmentsSection(customerId: customer.id),
              const SizedBox(height: 12),
              HistoryTimeline(customerId: customer.id),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  final String title;
  final List<Widget> children;
  const _SectionCard({required this.title, required this.children});

  @override
  Widget build(BuildContext context) => Card(
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 14,
              color: AppColors.primary,
            ),
          ),
          const Divider(),
          ...children,
        ],
      ),
    ),
  );
}

/// A label/value line inside a [_SectionCard]. Also backs the Phase 3
/// "Additional Fields" block, which can render an arbitrary number of
/// imported custom-field rows — the vertical padding here is the row's only
/// breathing room, so keep it generous rather than cramped even though these
/// rows aren't individually tappable.
class _Row extends StatelessWidget {
  final String label;
  final String value;
  final bool isMonetary;
  const _Row(this.label, this.value, {this.isMonetary = false});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 120,
          child: Text(
            label,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 12,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            // MANDATORY tabular-nums for every financial figure — labels
            // like loan number / dates pass isMonetary: false and are
            // unaffected.
            style: isMonetary
                ? const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ).tabular
                : const TextStyle(fontSize: 13),
          ),
        ),
      ],
    ),
  );
}
