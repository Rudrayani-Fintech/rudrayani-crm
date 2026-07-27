import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rudrayani_mobile/features/worklist/worklist_provider.dart';

void main() {
  group('dispositionCodesProvider', () {
    // Phase 1.3: switched from FutureProvider.autoDispose to a plain
    // FutureProvider so disposition codes stay cached across screen
    // navigations instead of being re-fetched (and failing outright
    // offline) every time the call-log screen opens.
    test('dispositionCodesProvider is defined as a (non-autoDispose) FutureProvider', () {
      expect(dispositionCodesProvider, isNotNull);
      expect(dispositionCodesProvider, isA<FutureProvider>());
      expect(dispositionCodesProvider, isNot(isA<AutoDisposeFutureProvider>()));
    });

    test('can read dispositionCodesProvider in a ProviderContainer', () async {
      // Minimal test: confirm the provider can be instantiated in a container
      // without errors. Full API testing is done via the manual device test
      // (which confirms codes are fetched and invalidation works end-to-end).
      final container = ProviderContainer();

      // Reading a FutureProvider never throws synchronously -- it returns
      // AsyncLoading immediately and resolves to AsyncError later once the
      // (unmocked) API call actually fails. This test previously asserted
      // the opposite (a synchronous throw) and was failing outright even
      // before this session's changes.
      final value = container.read(dispositionCodesProvider);
      expect(value, isA<AsyncLoading<List<Map<String, dynamic>>>>());
    });
  });
}
