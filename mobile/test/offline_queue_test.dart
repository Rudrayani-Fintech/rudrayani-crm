// Phase 9.1 offline queue tests. Full Hive/connectivity_plus platform
// channels aren't mockable anywhere in this test suite (see the note in
// home_shell_dashboard_role_test.dart), so -- matching that same established
// pattern -- this exercises the pure decision logic flush() relies on
// (classifyFailure, retry/dead-letter transitions, JSON round-trip) rather
// than mounting the full OfflineQueueNotifier against a real Hive box.
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/offline/offline_queue.dart';

DioException _withStatus(int? status, {DioExceptionType type = DioExceptionType.badResponse}) {
  final req = RequestOptions(path: '/payments');
  return DioException(
    requestOptions: req,
    type: type,
    response: status == null ? null : Response(requestOptions: req, statusCode: status),
  );
}

void main() {
  group('classifyFailure', () {
    test('a 500 response is transient (retried, not dropped)', () {
      expect(classifyFailure(_withStatus(500)), FailureClass.transient);
      expect(classifyFailure(_withStatus(503)), FailureClass.transient);
    });

    test('a 400/404/409 response is permanent (dropped, not retried)', () {
      expect(classifyFailure(_withStatus(400)), FailureClass.permanent);
      expect(classifyFailure(_withStatus(404)), FailureClass.permanent);
      expect(classifyFailure(_withStatus(409)), FailureClass.permanent);
      expect(classifyFailure(_withStatus(499)), FailureClass.permanent);
    });

    test('a connection error/timeout is offline (queue stays intact)', () {
      expect(
        classifyFailure(_withStatus(null, type: DioExceptionType.connectionError)),
        FailureClass.offline,
      );
      expect(
        classifyFailure(_withStatus(null, type: DioExceptionType.connectionTimeout)),
        FailureClass.offline,
      );
      expect(
        classifyFailure(_withStatus(null, type: DioExceptionType.sendTimeout)),
        FailureClass.offline,
      );
      expect(
        classifyFailure(_withStatus(null, type: DioExceptionType.receiveTimeout)),
        FailureClass.offline,
      );
    });

    test('an unrecognized error shape with no response is transient, not offline', () {
      // e.g. a JSON parse failure on a 200 -- DioExceptionType.unknown but
      // not a SocketException, so it must not be silently treated as offline
      // (which would stop the whole flush) nor as permanent (which would
      // drop a payment that may well have succeeded server-side).
      expect(classifyFailure(_withStatus(null, type: DioExceptionType.unknown)), FailureClass.transient);
    });
  });

  group('isOfflineError', () {
    test('matches only true connectivity failures', () {
      expect(isOfflineError(_withStatus(null, type: DioExceptionType.connectionError)), isTrue);
      expect(isOfflineError(_withStatus(500)), isFalse);
      expect(isOfflineError(_withStatus(400)), isFalse);
      expect(isOfflineError(Exception('not a DioException')), isFalse);
    });
  });

  group('QueuedAction', () {
    test('round-trips through JSON without losing retry/dead-letter state', () {
      final action = QueuedAction(
        clientKey: 'abc-123',
        type: 'payment',
        payload: {'customer_id': 'c1', 'amount': 500},
        photoPath: '/tmp/proof.jpg',
        createdAt: DateTime.utc(2026, 1, 15, 10, 30),
        retryCount: 3,
        deadLetter: false,
      );
      final restored = QueuedAction.fromJson(action.toJson());
      expect(restored.clientKey, action.clientKey);
      expect(restored.type, action.type);
      expect(restored.payload, action.payload);
      expect(restored.photoPath, action.photoPath);
      expect(restored.createdAt, action.createdAt);
      expect(restored.retryCount, action.retryCount);
      expect(restored.deadLetter, action.deadLetter);
    });

    test('ignores a legacy signature_path key from before signature capture was removed', () {
      final restored = QueuedAction.fromJson({
        'client_key': 'abc',
        'type': 'field_visit',
        'payload': <String, dynamic>{},
        'photo_path': null,
        'signature_path': '/tmp/old-signature.png',
        'created_at': DateTime.utc(2026, 1, 1).toIso8601String(),
      });
      expect(restored.clientKey, 'abc');
      // No signatureAgePath field exists on QueuedAction -- fromJson simply
      // never reads the key, so this must not throw.
    });

    test('withRetry increments retryCount and can flip deadLetter', () {
      final action = QueuedAction(
        clientKey: 'k',
        type: 'call_log',
        payload: const {},
        createdAt: DateTime.utc(2026, 1, 1),
        retryCount: maxAutoRetries - 2,
      );
      final once = action.withRetry(deadLetter: false);
      expect(once.retryCount, action.retryCount + 1);
      expect(once.deadLetter, isFalse);

      // The flush() threshold is `retryCount + 1 >= maxAutoRetries` --
      // verify the boundary this test's fixture is deliberately placed at.
      final atThreshold = once.withRetry(deadLetter: once.retryCount + 1 >= maxAutoRetries);
      expect(atThreshold.retryCount, maxAutoRetries);
      expect(atThreshold.deadLetter, isTrue);
    });
  });
}
