// Phase 6: the disposition-logging flow is now staged in 4 steps
// (Channel -> Result Code -> Dynamic Fields -> Remarks). The pure
// filtering/validation functions get direct unit tests; the channel-switch
// reset and dynamic-field visibility are stateful UI behaviour, so those get
// a widget test with the disposition/customer providers overridden with
// fixed fakes (no network, no secure storage -- apiClientProvider is never
// touched since neither overridden provider reads it, matching this
// project's stance of avoiding live-network unit tests, see
// disposition_provider_test.dart).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/models/customer.dart';
import 'package:rudrayani_mobile/core/models/disposition_code.dart';
import 'package:rudrayani_mobile/features/call_log/call_log_screen.dart';
import 'package:rudrayani_mobile/features/worklist/worklist_provider.dart';

DispositionCode _code({
  required String id,
  String? channel,
  String actionCode = 'OC',
  String resultCode = 'PTP',
  String description = 'Promise to Pay',
  bool needsAmount = false,
  bool needsDate = false,
  bool needsMode = false,
  bool needsReason = false,
  bool needsNameRelation = false,
}) =>
    DispositionCode(
      id: id,
      actionCode: actionCode,
      resultCode: resultCode,
      description: description,
      channel: channel,
      needsAmount: needsAmount,
      needsDate: needsDate,
      needsTime: false,
      needsMode: needsMode,
      needsReason: needsReason,
      needsNameRelation: needsNameRelation,
    );

void main() {
  group('codesForChannel', () {
    final codes = [
      _code(id: '1', channel: 'FV', description: 'Field visit made'),
      _code(id: '2', channel: 'OC', description: 'Called, no answer'),
      _code(id: '3', channel: 'FV', description: 'Door locked'),
    ];

    test('FV selection returns only FV codes', () {
      final result = codesForChannel(codes, 'FV');
      expect(result.map((c) => c.id), ['1', '3']);
    });

    test('OC selection excludes FV codes entirely', () {
      final result = codesForChannel(codes, 'OC');
      expect(result.map((c) => c.id), ['2']);
      expect(result.any((c) => c.channel == 'FV'), isFalse);
    });

    test('codes without a channel (legacy/custom) appear in neither list', () {
      final unset = _code(id: '4', channel: null, description: 'Custom code');
      final all = [...codes, unset];
      expect(codesForChannel(all, 'FV').any((c) => c.id == '4'), isFalse);
      expect(codesForChannel(all, 'OC').any((c) => c.id == '4'), isFalse);
    });
  });

  group('missingSteps (submission gating)', () {
    test('blocks submission when no channel is selected', () {
      final missing = missingSteps(
        channel: null,
        code: null,
        hasAmount: false,
        hasDate: false,
        hasMode: false,
        hasReason: false,
        hasNameRelation: false,
      );
      expect(missing, ['channel']);
    });

    test('blocks submission when channel is selected but no code yet', () {
      final missing = missingSteps(
        channel: 'OC',
        code: null,
        hasAmount: false,
        hasDate: false,
        hasMode: false,
        hasReason: false,
        hasNameRelation: false,
      );
      expect(missing, ['result code']);
    });

    test('blocks submission until the selected code\'s required fields are filled', () {
      final ptp = _code(id: '1', channel: 'OC', needsAmount: true, needsDate: true);
      final missing = missingSteps(
        channel: 'OC',
        code: ptp,
        hasAmount: false,
        hasDate: false,
        hasMode: false,
        hasReason: false,
        hasNameRelation: false,
      );
      expect(missing, containsAll(['amount', 'date']));
    });

    test('allows submission once channel, code, and required fields are satisfied', () {
      final ptp = _code(id: '1', channel: 'OC', needsAmount: true, needsDate: true);
      final missing = missingSteps(
        channel: 'OC',
        code: ptp,
        hasAmount: true,
        hasDate: true,
        hasMode: false,
        hasReason: false,
        hasNameRelation: false,
      );
      expect(missing, isEmpty);
    });

    test('a code with no needs_* flags requires nothing beyond channel + code', () {
      final callBack = _code(id: '2', channel: 'FV', description: 'Call back later');
      final missing = missingSteps(
        channel: 'FV',
        code: callBack,
        hasAmount: false,
        hasDate: false,
        hasMode: false,
        hasReason: false,
        hasNameRelation: false,
      );
      expect(missing, isEmpty); // remarks is optional, never listed
    });
  });

  group('CallLogScreen widget (4-step flow)', () {
    final fvCode = {
      'id': 'fv-1',
      'action_code': 'FV',
      'result_code': 'CB',
      'description': 'Call back later',
      'channel': 'FV',
      'needs_amount': false,
      'needs_date': false,
      'needs_time': false,
      'needs_mode': false,
      'needs_reason': false,
      'needs_name_relation': false,
    };
    final ocPtpCode = {
      'id': 'oc-1',
      'action_code': 'OC',
      'result_code': 'PTP',
      'description': 'Promise to pay',
      'channel': 'OC',
      'needs_amount': true,
      'needs_date': true,
      'needs_time': false,
      'needs_mode': false,
      'needs_reason': false,
      'needs_name_relation': false,
    };
    final ocRtpCode = {
      'id': 'oc-2',
      'action_code': 'OC',
      'result_code': 'RTP',
      'description': 'Refused to pay',
      'channel': 'OC',
      'needs_amount': false,
      'needs_date': false,
      'needs_time': false,
      'needs_mode': false,
      'needs_reason': true,
      'needs_name_relation': false,
    };

    final fakeCustomerJson = {
      'id': 'cust-1',
      'loan_number': 'LN-001',
      'customer_name': 'Test Customer',
      'mobile_number': '9999999999',
      'company_name': 'Test Co',
      'custom_fields': <String, dynamic>{},
    };

    Future<void> pumpScreen(WidgetTester tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dispositionCodesProvider.overrideWith(
              (ref) async => [fvCode, ocPtpCode, ocRtpCode],
            ),
            customerByIdProvider.overrideWith(
              (ref, id) async => Customer.fromJson(fakeCustomerJson),
            ),
          ],
          child: const MaterialApp(home: CallLogScreen(customerId: 'cust-1')),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('switching channel after picking a code asks for confirmation, then clears it',
        (tester) async {
      await pumpScreen(tester);

      await tester.tap(find.text('On-Call'));
      await tester.pumpAndSettle();

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OC_PTP — Promise to pay').last);
      await tester.pumpAndSettle();

      // Step 3 field for the PTP code is now visible.
      expect(find.text('Amount (₹) *'), findsOneWidget);

      // Switching channel now that a code is selected must not silently
      // wipe it -- confirm first (a mis-tap used to destroy a half-entered
      // disposition with no warning at all).
      await tester.tap(find.text('Field Visit'));
      await tester.pumpAndSettle();

      expect(find.text('Switch channel?'), findsOneWidget);
      // Declining leaves everything exactly as it was.
      expect(find.text('Amount (₹) *'), findsOneWidget);

      await tester.tap(find.text('Switch'));
      await tester.pumpAndSettle();

      expect(find.text('Amount (₹) *'), findsNothing);
      expect(find.text('OC_PTP — Promise to pay'), findsNothing);
    });

    testWidgets('tapping the already-selected channel does not clear anything', (tester) async {
      await pumpScreen(tester);

      await tester.tap(find.text('On-Call'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OC_PTP — Promise to pay').last);
      await tester.pumpAndSettle();

      // Re-tapping the segment that's already selected used to deselect it
      // (emptySelectionAllowed: true) and wipe the whole form.
      await tester.tap(find.text('On-Call'));
      await tester.pumpAndSettle();

      expect(find.text('Switch channel?'), findsNothing);
      expect(find.text('Amount (₹) *'), findsOneWidget);
      expect(find.text('OC_PTP — Promise to pay'), findsOneWidget); // still selected in the dropdown
    });

    testWidgets('dynamic fields switch to match the newly selected code', (tester) async {
      await pumpScreen(tester);

      await tester.tap(find.text('On-Call'));
      await tester.pumpAndSettle();

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OC_RTP — Refused to pay').last);
      await tester.pumpAndSettle();

      expect(find.text('Reason *'), findsOneWidget);
      expect(find.text('Amount (₹) *'), findsNothing);
    });

    testWidgets('result-code step only offers codes for the chosen channel', (tester) async {
      await pumpScreen(tester);

      await tester.tap(find.text('Field Visit'));
      await tester.pumpAndSettle();

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();

      expect(find.text('FV_CB — Call back later'), findsOneWidget);
      expect(find.text('OC_PTP — Promise to pay'), findsNothing);
      expect(find.text('OC_RTP — Refused to pay'), findsNothing);
    });
  });
}
