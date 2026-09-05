import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Standard section title -- replaces `_StepLabel`, `DashboardSectionHeader`
/// and assorted inline bold `Text` widgets used to mark off a group of
/// content within a screen.
class AppSectionHeader extends StatelessWidget {
  final String title;
  final Widget? trailing;
  const AppSectionHeader({super.key, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: AppColors.textSecondary,
                  ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}
