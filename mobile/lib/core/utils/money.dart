import 'package:intl/intl.dart';

/// Lakh/crore-notation money display ("₹ 1.04Cr"). Previously this exact
/// function -- byte-for-byte -- was copy-pasted as a private `_lakh` in four
/// separate dashboard screens, and none of the four rolled over past lakh,
/// so a 10+ crore portfolio rendered as e.g. "1039.39L" -- a number an
/// Indian collections owner reads as simply wrong.
String lakh(num? v) {
  if (v == null) return '—';
  final cr = v / 10000000;
  if (cr.abs() >= 1) return '${cr.toStringAsFixed(2)}Cr';
  final l = v / 100000;
  if (l.abs() >= 0.01) return '${l.toStringAsFixed(2)}L';
  return NumberFormat.decimalPattern('en_IN').format(v);
}

final _rupeeFormat = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);

/// Plain ₹-prefixed, comma-grouped display for an individual figure (a due
/// amount, a single payment, an EMI) -- as opposed to [lakh]'s aggregate/
/// portfolio notation. Previously this exact `NumberFormat.currency(...)`
/// instance was copy-pasted as a private `_rupee` in five separate screens.
String rupees(num? v) => v == null ? '—' : _rupeeFormat.format(v);
