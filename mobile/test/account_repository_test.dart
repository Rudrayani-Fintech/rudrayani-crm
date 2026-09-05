// Phase 9 (§7.2): AccountRepository tests. Full Hive/connectivity_plus
// platform channels aren't mockable anywhere in this test suite (see the
// note in offline_queue_test.dart), so the network-then-cache-fallback
// behaviour isn't covered by an automated test here -- this locks in the
// one piece of that logic that's pure and dependency-free: the
// collision-safe cache-key builder.
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/data/account_repository.dart';
import 'package:rudrayani_mobile/core/offline/worklist_filter_store.dart';

void main() {
  group('accountWorklistCacheKey', () {
    test('differs by scope alone', () {
      const filters = WorklistFilterSelection();
      expect(
        accountWorklistCacheKey('personal', filters),
        isNot(accountWorklistCacheKey('team', filters)),
      );
    });

    test('does not collide when a branch name contains an underscore', () {
      // The bug this key scheme fixes: a naive join('_') made
      // branches:["A","B"] and branches:["A_B"] produce the same key.
      final a = accountWorklistCacheKey(
        'personal',
        const WorklistFilterSelection(branches: ['A', 'B']),
      );
      final b = accountWorklistCacheKey(
        'personal',
        const WorklistFilterSelection(branches: ['A_B']),
      );
      expect(a, isNot(b));
    });

    test('does not collide across the branches/buckets segment boundary', () {
      final a = accountWorklistCacheKey(
        'personal',
        const WorklistFilterSelection(branches: ['A', 'B'], buckets: ['C']),
      );
      final b = accountWorklistCacheKey(
        'personal',
        const WorklistFilterSelection(branches: ['A'], buckets: ['B', 'C']),
      );
      expect(a, isNot(b));
    });

    test('is stable for the same scope and filter selection', () {
      const filters = WorklistFilterSelection(branches: ['Pune'], buckets: ['30']);
      expect(
        accountWorklistCacheKey('personal', filters),
        accountWorklistCacheKey('personal', filters),
      );
    });
  });
}
