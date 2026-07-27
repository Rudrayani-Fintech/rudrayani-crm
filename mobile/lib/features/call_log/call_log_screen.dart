import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/models/disposition_code.dart';
import '../../core/offline/offline_queue.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/widgets/state_views.dart';
import '../worklist/worklist_provider.dart';

/// Result codes available for a given channel — step 2 of the 4-step flow
/// only shows codes tagged for the channel picked in step 1 (custom codes an
/// admin hasn't tagged with a channel yet are excluded from both lists until
/// they are). Pure function so the filtering behaviour is unit-testable
/// without pumping the whole screen (see call_log_screen_test.dart).
List<DispositionCode> codesForChannel(List<DispositionCode> codes, String channel) {
  return codes.where((c) => c.channel == channel).toList();
}

/// Which required steps of the 4-step flow (Channel -> Result Code ->
/// Dynamic Fields -> Remarks) are still missing, in the order they should be
/// resolved. Remarks is optional, so it never appears here. Pure function so
/// "submission blocked until satisfied" is unit-testable independent of the
/// widget tree.
List<String> missingSteps({
  required String? channel,
  required DispositionCode? code,
  required bool hasAmount,
  required bool hasDate,
  required bool hasMode,
  required bool hasReason,
  required bool hasNameRelation,
}) {
  if (channel == null) return const ['channel'];
  if (code == null) return const ['result code'];
  final missing = <String>[];
  if (code.needsAmount && !hasAmount) missing.add('amount');
  if (code.needsDate && !hasDate) missing.add('date');
  if (code.needsMode && !hasMode) missing.add('payment mode');
  if (code.needsReason && !hasReason) missing.add('reason');
  if (code.needsNameRelation && !hasNameRelation) missing.add('name/relation');
  return missing;
}

class CallLogScreen extends ConsumerStatefulWidget {
  final String customerId;
  const CallLogScreen({super.key, required this.customerId});

  @override
  ConsumerState<CallLogScreen> createState() => _CallLogScreenState();
}

class _CallLogScreenState extends ConsumerState<CallLogScreen> {
  // Step 1
  String? _selectedChannel; // 'FV' or 'OC'
  // Step 2
  String? _selectedCodeId;
  // Step 3
  final _amountCtrl = TextEditingController();
  final _dateCtrl = TextEditingController();
  final _timeCtrl = TextEditingController();
  final _modeCtrl = TextEditingController();
  final _reasonCtrl = TextEditingController();
  final _nameRelCtrl = TextEditingController();
  // Step 4
  final _extraCtrl = TextEditingController();
  bool _loading = false;
  String? _error;
  String _remarkPreview = '';

  @override
  void initState() {
    super.initState();
    // A telecaller only ever calls; a field agent only ever visits in
    // person -- requiring a channel pick was a guaranteed wasted tap on
    // every single disposition, every day, for the common single-capability
    // case. A dual-capability user still has to choose, since either could
    // apply to a given interaction.
    final auth = ref.read(authProvider.notifier);
    if (auth.isTelecaller && !auth.isFieldAgent) {
      _selectedChannel = 'OC';
    } else if (auth.isFieldAgent && !auth.isTelecaller) {
      _selectedChannel = 'FV';
    }
  }

  @override
  void dispose() {
    _amountCtrl.dispose();
    _dateCtrl.dispose();
    _timeCtrl.dispose();
    _modeCtrl.dispose();
    _reasonCtrl.dispose();
    _nameRelCtrl.dispose();
    _extraCtrl.dispose();
    super.dispose();
  }

  /// The list of disposition codes fetched by the provider, decoded once.
  /// Recomputed on demand (rather than cached in state) so it always
  /// reflects the provider's current cache without needing an object-identity
  /// match across rebuilds.
  List<DispositionCode> get _allCodes {
    final raw = ref.read(dispositionCodesProvider).valueOrNull ?? const [];
    return raw.map(DispositionCode.fromJson).toList();
  }

  List<DispositionCode> get _channelCodes {
    if (_selectedChannel == null) return const [];
    return codesForChannel(_allCodes, _selectedChannel!);
  }

  DispositionCode? get _selectedCode {
    final id = _selectedCodeId;
    if (id == null) return null;
    for (final c in _channelCodes) {
      if (c.id == id) return c;
    }
    return null;
  }

  /// Step 1 -> switching channel invalidates whatever result code (and its
  /// step-3 fields) was chosen for the previous channel.
  void _selectChannel(String? channel) {
    setState(() {
      _selectedChannel = channel;
      _selectedCodeId = null;
      _error = null;
      _amountCtrl.clear();
      _dateCtrl.clear();
      _timeCtrl.clear();
      _modeCtrl.clear();
      _reasonCtrl.clear();
      _nameRelCtrl.clear();
      _remarkPreview = '';
    });
  }

  bool get _hasEnteredDetails =>
      _selectedCodeId != null ||
      _amountCtrl.text.isNotEmpty ||
      _dateCtrl.text.isNotEmpty ||
      _timeCtrl.text.isNotEmpty ||
      _modeCtrl.text.isNotEmpty ||
      _reasonCtrl.text.isNotEmpty ||
      _nameRelCtrl.text.isNotEmpty ||
      _extraCtrl.text.isNotEmpty;

  /// A real channel switch (not the initial pick) used to wipe steps 2-4
  /// with no warning -- a mis-tap destroyed a half-entered disposition.
  Future<void> _handleChannelSelection(String newChannel) async {
    if (newChannel == _selectedChannel) return;
    if (_selectedChannel != null && _hasEnteredDetails) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Switch channel?'),
          content: const Text('This will clear the result code and details you\'ve entered so far.'),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
            TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Switch')),
          ],
        ),
      );
      if (confirmed != true) return;
    }
    _selectChannel(newChannel);
  }

  void _updatePreview() {
    final code = _selectedCode;
    if (code == null) return;
    final parts = <String>[];
    if (code.needsAmount && _amountCtrl.text.isNotEmpty) {
      parts.add('₹${_amountCtrl.text}');
    }
    if (code.needsDate && _dateCtrl.text.isNotEmpty) { parts.add(_dateCtrl.text); }
    if (code.needsMode && _modeCtrl.text.isNotEmpty) { parts.add(_modeCtrl.text); }
    if (code.needsReason && _reasonCtrl.text.isNotEmpty) { parts.add(_reasonCtrl.text); }
    if (code.needsNameRelation && _nameRelCtrl.text.isNotEmpty) { parts.add(_nameRelCtrl.text); }
    final extra = _extraCtrl.text.isNotEmpty ? ' — ${_extraCtrl.text}' : '';
    setState(() => _remarkPreview = parts.join(' | ') + extra);
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

  Future<void> _submit() async {
    final code = _selectedCode;
    final missing = missingSteps(
      channel: _selectedChannel,
      code: code,
      hasAmount: _amountCtrl.text.isNotEmpty,
      hasDate: _dateCtrl.text.isNotEmpty,
      hasMode: _modeCtrl.text.isNotEmpty,
      hasReason: _reasonCtrl.text.isNotEmpty,
      hasNameRelation: _nameRelCtrl.text.isNotEmpty,
    );
    if (missing.isNotEmpty) {
      setState(() => _error = 'Please provide: ${missing.join(', ')}');
      return;
    }
    // missingSteps() guarantees code is non-null once it returns empty.
    final selected = code!;

    setState(() { _loading = true; _error = null; });
    try {
      final api = ref.read(apiClientProvider);
      final fields = <String, dynamic>{};
      if (selected.needsAmount && _amountCtrl.text.isNotEmpty) {
        fields['amount'] = double.parse(_amountCtrl.text);
      }
      if (selected.needsDate && _dateCtrl.text.isNotEmpty) { fields['date'] = _dateCtrl.text; }
      if (selected.needsTime && _timeCtrl.text.isNotEmpty) { fields['time'] = _timeCtrl.text; }
      if (selected.needsMode && _modeCtrl.text.isNotEmpty) { fields['mode'] = _modeCtrl.text; }
      if (selected.needsReason && _reasonCtrl.text.isNotEmpty) { fields['reason'] = _reasonCtrl.text; }
      if (selected.needsNameRelation && _nameRelCtrl.text.isNotEmpty) {
        fields['name_relation'] = _nameRelCtrl.text;
      }

      // One key for both paths: if the request reached the server but the
      // response was lost, the queued re-send must reuse the same key.
      final payload = {
        'customer_id': widget.customerId,
        'disposition_code_id': selected.id,
        'fields': fields,
        if (_extraCtrl.text.isNotEmpty) 'extra_remark': _extraCtrl.text,
        'client_key': OfflineQueueNotifier.newClientKey(),
      };
      try {
        await api.post('/call-logs', data: payload);
      } catch (e) {
        if (!isOfflineError(e)) rethrow;
        // No network — queue it; the client_key makes the later sync safe.
        await ref.read(offlineQueueProvider.notifier).enqueue(QueuedAction(
              clientKey: payload['client_key'] as String,
              type: 'call_log',
              payload: payload,
              createdAt: DateTime.now(),
            ));
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('No network — call log saved offline, will sync automatically'),
              backgroundColor: AppColors.warning,
            ),
          );
          context.pop();
        }
        return;
      }

      if (mounted) {
        ref.invalidate(worklistProvider);
        ref.invalidate(dispositionCodesProvider);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Call log saved!'), backgroundColor: AppColors.success),
        );
        context.pop();
      }
    } catch (e) {
      setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final codesAsync = ref.watch(dispositionCodesProvider);
    final customerAsync = ref.watch(customerByIdProvider(widget.customerId));
    final selectedCode = _selectedCode;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.onPrimary,
        title: Text(
          customerAsync.maybeWhen(
            data: (c) => 'Log Call — ${c.customerName}',
            orElse: () => 'Log Call',
          ),
        ),
      ),
      // 24px input safe zones (design brief §4 — high-velocity disposition
      // entry): this 4-step flow is the highest density-risk screen in the
      // app, so give each step's controls extra breathing room.
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Step 1: Channel — pre-selected by role when unambiguous (see
            // initState); required otherwise. emptySelectionAllowed: false
            // stops a tap on the already-selected segment from deselecting
            // it (and wiping steps 2-4) -- a genuine switch is still
            // confirmed in _handleChannelSelection if details were entered.
            const _StepLabel(step: 1, label: 'Channel'),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              style: SegmentedButton.styleFrom(
                minimumSize: const Size(64, AppDimens.tapTarget),
              ),
              segments: const [
                ButtonSegment(
                  value: 'FV',
                  label: Text('Field Visit'),
                  icon: Icon(Icons.home_outlined),
                ),
                ButtonSegment(
                  value: 'OC',
                  label: Text('On-Call'),
                  icon: Icon(Icons.call_outlined),
                ),
              ],
              selected: _selectedChannel == null ? const {} : {_selectedChannel!},
              emptySelectionAllowed: _selectedChannel == null,
              onSelectionChanged: (selection) {
                if (selection.isEmpty) return;
                _handleChannelSelection(selection.first);
              },
            ),
            const SizedBox(height: 20),

            if (_selectedChannel != null) ...[
              // Step 2: Result code, filtered to the chosen channel; resets
              // when channel changes (handled in _selectChannel above).
              const _StepLabel(step: 2, label: 'Result Code'),
              const SizedBox(height: 8),
              codesAsync.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => InlineErrorNote(
                  message: 'Could not load result codes: ${friendlyError(e)}',
                  onRetry: () => ref.invalidate(dispositionCodesProvider),
                ),
                data: (_) {
                  final channelCodes = _channelCodes;
                  return DropdownButtonFormField<String>(
                    isExpanded: true,
                    initialValue: _selectedCodeId,
                    decoration: InputDecoration(
                      labelText: 'Result Code *',
                      border: const OutlineInputBorder(),
                      helperText: channelCodes.isEmpty
                          ? 'No $_selectedChannel codes configured yet'
                          : null,
                    ),
                    items: channelCodes
                        .map((c) => DropdownMenuItem(
                              value: c.id,
                              child: Text(
                                '${c.actionCode}_${c.resultCode} — ${c.description}',
                                overflow: TextOverflow.ellipsis,
                              ),
                            ))
                        .toList(),
                    onChanged: (id) {
                      setState(() { _selectedCodeId = id; _error = null; });
                      _updatePreview();
                    },
                  );
                },
              ),
            ],

            if (selectedCode != null) ...[
              const SizedBox(height: 20),
              // Step 3: dynamic fields, driven purely by the selected code's
              // needs_* flags (locked to result-code selection).
              const _StepLabel(step: 3, label: 'Details'),
              const SizedBox(height: 8),
              if (selectedCode.needsAmount) ...[
                TextField(
                  controller: _amountCtrl,
                  keyboardType: TextInputType.number,
                  // Tabular-nums (MANDATORY, design brief) even while typing.
                  style: const TextStyle().tabular,
                  decoration: const InputDecoration(
                    labelText: 'Amount (₹) *',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.currency_rupee),
                  ),
                  onChanged: (_) => _updatePreview(),
                ),
                const SizedBox(height: 12),
              ],
              if (selectedCode.needsDate) ...[
                TextField(
                  controller: _dateCtrl,
                  readOnly: true,
                  decoration: const InputDecoration(
                    labelText: 'Date *',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.calendar_today),
                  ),
                  onTap: _pickDate,
                ),
                const SizedBox(height: 12),
              ],
              if (selectedCode.needsTime) ...[
                TextField(
                  controller: _timeCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Time (HH:MM)',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.access_time),
                  ),
                  onChanged: (_) => _updatePreview(),
                ),
                const SizedBox(height: 12),
              ],
              if (selectedCode.needsMode) ...[
                DropdownButtonFormField<String>(
                  initialValue: _modeCtrl.text.isEmpty ? null : _modeCtrl.text,
                  decoration: const InputDecoration(
                    labelText: 'Payment Mode *',
                    border: OutlineInputBorder(),
                  ),
                  items: ['NEFT', 'RTGS', 'Cash', 'UPI', 'Cheque', 'DD']
                      .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                      .toList(),
                  onChanged: (v) {
                    _modeCtrl.text = v ?? '';
                    _updatePreview();
                  },
                ),
                const SizedBox(height: 12),
              ],
              if (selectedCode.needsReason) ...[
                TextField(
                  controller: _reasonCtrl,
                  maxLines: 2,
                  decoration: const InputDecoration(
                    labelText: 'Reason *',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (_) => _updatePreview(),
                ),
                const SizedBox(height: 12),
              ],
              if (selectedCode.needsNameRelation) ...[
                TextField(
                  controller: _nameRelCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Name / Relation *',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (_) => _updatePreview(),
                ),
                const SizedBox(height: 12),
              ],

              const SizedBox(height: 8),
              // Step 4: Remarks — last step before submit.
              const _StepLabel(step: 4, label: 'Remarks'),
              const SizedBox(height: 8),
              TextField(
                controller: _extraCtrl,
                maxLines: 2,
                decoration: const InputDecoration(
                  labelText: 'Remarks (optional)',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => _updatePreview(),
              ),
              const SizedBox(height: 12),
              // Remark preview
              if (_remarkPreview.isNotEmpty) ...[
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.successContainer,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: AppColors.success.withValues(alpha: 0.3),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Remark Preview', style: TextStyle(fontSize: 11, color: AppColors.successStrong, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      Text(_remarkPreview, style: const TextStyle(fontSize: 13).tabular),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
              ],
            ],
            // Extra bottom padding so the last field never sits flush
            // against the persistent save bar below.
            const SizedBox(height: 8),
          ],
        ),
      ),
      // Persistent save bar (design brief 3.7): with four dynamic fields the
      // primary action used to sit at the bottom of a SingleChildScrollView,
      // costing a scroll on every single disposition entered.
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
                label: Text(_loading ? 'Saving…' : 'Save Call Log'),
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

/// "Step N — Label" section heading used across all four stages of the flow.
class _StepLabel extends StatelessWidget {
  final int step;
  final String label;
  const _StepLabel({required this.step, required this.label});

  @override
  Widget build(BuildContext context) {
    return Text(
      'Step $step — $label',
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.bold,
        color: AppColors.textSecondary,
      ),
    );
  }
}
