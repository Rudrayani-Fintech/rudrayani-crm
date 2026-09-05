import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Standard content card -- replaces the 37 hand-rolled
/// `Card` + `BorderRadius.circular(8)` combinations across `lib/`. Shape
/// comes from the app's `CardThemeData` (`AppRadius.lg`); this widget just
/// standardizes padding and the optional tap behaviour.
class AppCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.lg),
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final content = Padding(padding: padding, child: child);
    return Card(
      margin: EdgeInsets.zero,
      child: onTap == null
          ? content
          : InkWell(
              onTap: onTap,
              borderRadius: BorderRadius.circular(AppRadius.lg),
              child: content,
            ),
    );
  }
}
