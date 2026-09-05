// Phase 12 (My Day, §5.1, P4, P5).
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/features/myday/myday_screen.dart';

void main() {
  group('findSelfRow', () {
    test('finds the row matching the signed-in user id', () {
      final members = [
        {'user_id': 'a', 'calls': 1},
        {'user_id': 'b', 'calls': 2},
      ];
      expect(findSelfRow(members, 'b'), {'user_id': 'b', 'calls': 2});
    });

    test('falls back to the first row when the user id is unknown', () {
      final members = [
        {'user_id': 'a', 'calls': 1},
      ];
      expect(findSelfRow(members, null), {'user_id': 'a', 'calls': 1});
      expect(findSelfRow(members, 'missing'), {'user_id': 'a', 'calls': 1});
    });

    test('returns null for an empty list', () {
      expect(findSelfRow(const [], 'a'), isNull);
    });
  });
}
