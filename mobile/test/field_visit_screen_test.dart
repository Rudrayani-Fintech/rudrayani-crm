// Phase 11 (I1-I6, §5.1): Log Visit screen acceptance tests. Covers the
// pure functions the widget builds on -- full-widget-tree testing would need
// Dio/Hive platform channels this suite doesn't mock (see the note in
// test/offline_queue_test.dart).
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/models/disposition_code.dart';
import 'package:rudrayani_mobile/features/field_visit/field_visit_screen.dart';

DispositionCode _code({
  required String id,
  String resultCode = 'X',
  String? category,
  bool needsAmount = false,
  bool needsDate = false,
  bool needsMode = false,
  bool needsReason = false,
  bool needsNameRelation = false,
  String channel = 'FV',
}) =>
    DispositionCode(
      id: id,
      actionCode: 'FV',
      resultCode: resultCode,
      description: resultCode,
      channel: channel,
      category: category,
      needsAmount: needsAmount,
      needsDate: needsDate,
      needsTime: false,
      needsMode: needsMode,
      needsReason: needsReason,
      needsNameRelation: needsNameRelation,
    );

void main() {
  group('fvCodes', () {
    test('keeps only FV-channel codes (I3: field agents get FV plus shared)', () {
      final codes = [
        _code(id: '1', channel: 'FV'),
        _code(id: '2', channel: 'OC'),
        _code(id: '3', channel: 'FV'),
      ];
      expect(fvCodes(codes).map((c) => c.id).toList(), ['1', '3']);
    });

    test('excludes codes with no channel (legacy/custom, not yet tagged by an admin)', () {
      final codes = [_code(id: '1', channel: 'FV')];
      // No `channel:` override -> defaults to null via the model's optional field.
      final untagged = DispositionCode(
        id: '2',
        actionCode: 'X',
        resultCode: 'X',
        description: 'X',
        needsAmount: false,
        needsDate: false,
        needsTime: false,
        needsMode: false,
        needsReason: false,
        needsNameRelation: false,
      );
      expect(fvCodes([...codes, untagged]).map((c) => c.id).toList(), ['1']);
    });
  });

  group('missingLogVisitFields (I5: required-date enforcement)', () {
    test('requires a trail code before anything else', () {
      expect(
        missingLogVisitFields(
          code: null,
          hasAmount: false,
          hasDate: false,
          hasMode: false,
          hasReason: false,
          hasNameRelation: false,
        ),
        ['trail code'],
      );
    });

    test('a PTP-flavoured code demands both amount and date', () {
      final ptp = _code(id: '1', resultCode: 'PTP', category: 'PROMISE TO PAY', needsAmount: true, needsDate: true);
      expect(
        missingLogVisitFields(code: ptp, hasAmount: false, hasDate: false, hasMode: false, hasReason: false, hasNameRelation: false),
        containsAll(['amount', 'date']),
      );
      expect(
        missingLogVisitFields(code: ptp, hasAmount: true, hasDate: true, hasMode: false, hasReason: false, hasNameRelation: false),
        isEmpty,
      );
    });

    test('a code needing no fields is satisfied by selection alone', () {
      final simple = _code(id: '1', resultCode: 'RNR');
      expect(
        missingLogVisitFields(code: simple, hasAmount: false, hasDate: false, hasMode: false, hasReason: false, hasNameRelation: false),
        isEmpty,
      );
    });
  });

  group('dispositionCreatesPtp (mirrors backend disposition-service.ts)', () {
    test('a promise-shaped code with amount+date creates a PTP', () {
      final ptp = _code(id: '1', resultCode: 'PTP', category: 'PROMISE TO PAY', needsAmount: true, needsDate: true);
      expect(dispositionCreatesPtp(ptp), isTrue);
    });

    test('a broken-promise entry does not create a fresh PTP', () {
      final broken = _code(id: '1', resultCode: 'BROKEN PTP', category: 'BROKEN PROMISE', needsAmount: true, needsDate: true);
      expect(dispositionCreatesPtp(broken), isFalse);
    });

    test('a code missing either amount or date is never a PTP', () {
      final noDate = _code(id: '1', resultCode: 'PTP', needsAmount: true, needsDate: false);
      expect(dispositionCreatesPtp(noDate), isFalse);
    });

    test('a plain collection code (amount, no promise wording) is not a PTP', () {
      final paid = _code(id: '1', resultCode: 'PAID', needsAmount: true, needsDate: false);
      expect(dispositionCreatesPtp(paid), isFalse);
    });
  });

  group('buildLogVisitPayload (X3: the outcome always reaches the payload)', () {
    test('always carries disposition_code_id, regardless of the code chosen', () {
      final code = _code(id: 'rnr-1', resultCode: 'RNR');
      final payload = buildLogVisitPayload(
        customerId: 'cust-1',
        code: code,
        fields: const {},
        extraRemark: '',
        clientKey: 'key-1',
      );
      expect(payload['disposition_code_id'], 'rnr-1');
      expect(payload['customer_id'], 'cust-1');
      expect(payload.containsKey('payment'), isFalse);
    });

    test('embeds a payment for a real collection code (I2, §4.4)', () {
      final paid = _code(id: 'paid-1', resultCode: 'PAID', needsAmount: true, needsMode: true);
      final payload = buildLogVisitPayload(
        customerId: 'cust-1',
        code: paid,
        fields: const {'amount': 500.0, 'mode': 'Cash'},
        extraRemark: '',
        clientKey: 'key-2',
      );
      expect(payload['payment'], {'amount': 500.0, 'mode': 'Cash'});
    });

    test('does NOT embed a payment for a PTP -- the amount is a future promise, not money collected', () {
      final ptp = _code(id: 'ptp-1', resultCode: 'PTP', category: 'PROMISE TO PAY', needsAmount: true, needsDate: true);
      final payload = buildLogVisitPayload(
        customerId: 'cust-1',
        code: ptp,
        fields: const {'amount': 2000.0, 'date': '2026-09-10'},
        extraRemark: '',
        clientKey: 'key-3',
      );
      expect(payload.containsKey('payment'), isFalse);
      expect(payload['fields'], {'amount': 2000.0, 'date': '2026-09-10'});
    });

    test('offline-queued payload has the same shape as the live one (same function, one client_key)', () {
      final paid = _code(id: 'paid-1', resultCode: 'PAID', needsAmount: true);
      final payload = buildLogVisitPayload(
        customerId: 'cust-2',
        code: paid,
        fields: const {'amount': 1200.0},
        extraRemark: 'left at reception',
        clientKey: 'queued-key',
      );
      expect(payload['client_key'], 'queued-key');
      expect(payload['extra_remark'], 'left at reception');
      expect(payload['payment'], {'amount': 1200.0});
    });
  });

  group('groupCodesByCategory (§5.1: grouped pills, most-used first)', () {
    test('groups by category and orders codes within a group by usage descending', () {
      final codes = [
        _code(id: 'a', category: 'NOT CONNECTED'),
        _code(id: 'b', category: 'NOT CONNECTED'),
        _code(id: 'c', category: 'NOT CONNECTED'),
      ];
      final groups = groupCodesByCategory(codes, {'c': 5, 'a': 2, 'b': 0});
      expect(groups.length, 1);
      expect(groups.first.value.map((c) => c.id).toList(), ['c', 'a', 'b']);
    });

    test('groups with no category fall under "Other"', () {
      final codes = [_code(id: 'a', category: null), _code(id: 'b', category: '')];
      final groups = groupCodesByCategory(codes, const {});
      expect(groups.single.key, 'Other');
    });

    test('orders groups by their own most-used code, most-used group first', () {
      final codes = [
        _code(id: 'rare', category: 'RARE'),
        _code(id: 'common', category: 'COMMON'),
      ];
      final groups = groupCodesByCategory(codes, {'common': 10, 'rare': 1});
      expect(groups.map((g) => g.key).toList(), ['COMMON', 'RARE']);
    });

    test('an all-zero-usage list keeps groups in their original relative order', () {
      final codes = [
        _code(id: 'a', category: 'ALPHA'),
        _code(id: 'b', category: 'BETA'),
      ];
      final groups = groupCodesByCategory(codes, const {});
      expect(groups.map((g) => g.key).toList(), ['ALPHA', 'BETA']);
    });
  });
}
