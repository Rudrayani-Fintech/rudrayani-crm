// Phase 13 (X6, A4): phone-number validation must match the backend's own
// 8-15 digit range, not the mobile app's previous hardcoded 10.
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/features/auth/password_reset_request_screen.dart';

void main() {
  group('phoneDigitsRegExp', () {
    test('accepts the 8-digit lower bound', () {
      expect(phoneDigitsRegExp.hasMatch('12345678'), isTrue);
    });

    test('accepts the 15-digit upper bound', () {
      expect(phoneDigitsRegExp.hasMatch('123456789012345'), isTrue);
    });

    test('accepts a plain 10-digit Indian mobile number', () {
      expect(phoneDigitsRegExp.hasMatch('9876543210'), isTrue);
    });

    test('rejects 7 digits (below the backend minimum)', () {
      expect(phoneDigitsRegExp.hasMatch('1234567'), isFalse);
    });

    test('rejects 16 digits (above the backend maximum)', () {
      expect(phoneDigitsRegExp.hasMatch('1234567890123456'), isFalse);
    });

    test('rejects non-digit characters', () {
      expect(phoneDigitsRegExp.hasMatch('98765-43210'), isFalse);
      expect(phoneDigitsRegExp.hasMatch('+919876543210'), isFalse);
    });
  });
}
