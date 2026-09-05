class DispositionCode {
  final String id;
  final String actionCode;
  final String resultCode;
  final String description;
  // FV (field visit) or OC (on-call) -- null for legacy/custom codes an
  // admin hasn't tagged yet; those are excluded from both channel lists in
  // the call-log picker until an admin assigns one (see DispositionsPage).
  final String? channel;
  // Groups the Log Visit trail-code pills (§5.1: "grouped pills"), e.g.
  // "PROMISE TO PAY", "NOT CONNECTED" -- seeded from Trail_Codes.xlsx
  // (§4.2). Null/blank codes group under "Other".
  final String? category;
  final bool needsAmount;
  final bool needsDate;
  final bool needsTime;
  final bool needsMode;
  final bool needsReason;
  final bool needsNameRelation;

  const DispositionCode({
    required this.id,
    required this.actionCode,
    required this.resultCode,
    required this.description,
    this.channel,
    this.category,
    required this.needsAmount,
    required this.needsDate,
    required this.needsTime,
    required this.needsMode,
    required this.needsReason,
    required this.needsNameRelation,
  });

  factory DispositionCode.fromJson(Map<String, dynamic> j) => DispositionCode(
        id: j['id'] as String,
        actionCode: j['action_code'] as String,
        resultCode: (j['result_code'] as String?) ?? '',
        description: (j['description'] as String?) ?? '',
        channel: j['channel'] as String?,
        category: j['category'] as String?,
        needsAmount: j['needs_amount'] == true,
        needsDate: j['needs_date'] == true,
        needsTime: j['needs_time'] == true,
        needsMode: j['needs_mode'] == true,
        needsReason: j['needs_reason'] == true,
        needsNameRelation: j['needs_name_relation'] == true,
      );

  String get display => '${actionCode}_$resultCode — $description';
}

/// Mirrors the backend's `createsPtp()` exactly (disposition-service.ts) --
/// the client needs to know, before submitting, whether an amount+date code
/// is a *promise* (no money collected yet, no payment to embed) or an
/// *actual collection* (embed a payment) to decide what to send and how to
/// frame the amount field ("Amount collected" vs "Promised amount"). Kept as
/// a pure top-level function, matching the pattern used for
/// `codesForChannel`/`missingSteps` in the old call_log_screen.dart, so this
/// duplication has its own fast unit test rather than trusting it stays in
/// sync with the server by inspection alone.
bool dispositionCreatesPtp(DispositionCode code) {
  if (!code.needsAmount || !code.needsDate) return false;
  final haystack = [code.resultCode, code.category, code.description].join(' ');
  final isPromise = RegExp('ptp|promise', caseSensitive: false).hasMatch(haystack);
  final isBroken = RegExp('broken', caseSensitive: false).hasMatch(haystack);
  return isPromise && !isBroken;
}
