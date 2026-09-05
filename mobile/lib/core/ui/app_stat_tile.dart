import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import 'app_card.dart';

/// Standard "label over a big figure" stat display -- replaces
/// `DashboardStatCard`, `_StatCard` and `SummaryStat`. [value] is a widget
/// rather than a string so callers can pass an [AppMoney] for currency
/// figures (mandatory tabular alignment) or a plain [Text] for counts.
class AppStatTile extends StatelessWidget {
  final String label;
  final Widget value;
  final IconData? icon;
  final Color? accentColor;

  const AppStatTile({
    super.key,
    required this.label,
    required this.value,
    this.icon,
    this.accentColor,
  });

  @override
  Widget build(BuildContext context) {
    final color = accentColor ?? AppColors.primary;
    return AppCard(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (icon != null) ...[
                Icon(icon, size: 18, color: color),
                const SizedBox(width: AppSpacing.xs),
              ],
              Expanded(
                child: Text(
                  label,
                  style: Theme.of(context)
                      .textTheme
                      .labelMedium
                      ?.copyWith(color: AppColors.textSecondary),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          DefaultTextStyle.merge(
            style: Theme.of(context)
                .textTheme
                .headlineSmall
                ?.copyWith(fontWeight: FontWeight.w700, color: color),
            child: value,
          ),
        ],
      ),
    );
  }
}
