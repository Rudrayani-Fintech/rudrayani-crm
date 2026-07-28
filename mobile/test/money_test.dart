// Phase 9.1 / Phase 7.1 regression net: lakh() previously never rolled over
// past lakh, so a 10+ crore portfolio rendered as e.g. "1039.39L" instead of
// crore notation. Locks in the crore rollover and the shared formatter.
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/utils/money.dart';

void main() {
  group('lakh', () {
    test('renders null as an em dash', () {
      expect(lakh(null), '—');
    });

    test('renders amounts below the 0.01L threshold as plain grouped digits', () {
      // The L threshold is 0.01L (= 1,000); this must sit just under it.
      expect(lakh(500), '500');
    });

    test('renders lakh-range amounts with L suffix', () {
      expect(lakh(250000), '2.50L');
    });

    test('rolls over to crore notation above 1 crore -- the reported bug', () {
      // 10.4 crore previously rendered as "1039.39L"; must now show Cr.
      expect(lakh(103939000), '10.39Cr');
      expect(lakh(10000000), '1.00Cr');
    });

    test('handles negative amounts (e.g. a reversed/negative adjustment)', () {
      expect(lakh(-10000000), '-1.00Cr');
    });
  });

  group('rupees', () {
    test('renders null as an em dash', () {
      expect(rupees(null), '—');
    });

    test('renders a plain grouped rupee figure with symbol', () {
      expect(rupees(4500), '₹4,500');
    });

    test('groups large individual figures using Indian digit grouping', () {
      expect(rupees(1250000), '₹12,50,000');
    });
  });
}
