import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../utils/money.dart' as money;

/// Renders a rupee figure with mandatory tabular-figure alignment (design
/// brief: "font-variant-numeric: tabular-nums") so digits line up in a
/// fixed-width column -- matters for glare/sunlight readability in the
/// field. Replaces the `_rupee` helper copy-pasted in five separate
/// screens (`worklist_screen.dart`, `history_timeline.dart`,
/// `customer_detail_screen.dart`, `ptps_screen.dart`, `today_section.dart`).
///
/// Set [compact] for portfolio/aggregate figures that should roll over into
/// lakh/crore notation ("₹1.04Cr") instead of a full comma-grouped number.
class AppMoney extends StatelessWidget {
  final num? value;
  final bool compact;
  final TextStyle? style;
  final TextAlign? textAlign;
  const AppMoney(
    this.value, {
    super.key,
    this.compact = false,
    this.style,
    this.textAlign,
  });

  @override
  Widget build(BuildContext context) {
    final text = compact ? money.lakh(value) : money.rupees(value);
    final base = style ?? DefaultTextStyle.of(context).style;
    return Text(text, style: base.tabular, textAlign: textAlign);
  }
}
