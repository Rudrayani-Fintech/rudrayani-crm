import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Primary call-to-action button. Sizing already comes from the app's
/// `ElevatedButtonThemeData` (`AppDimens.tapTarget` == 48px minimum height),
/// but this widget makes that guarantee explicit and independent of theme
/// wiring, plus adds the loading-spinner convenience every submit button
/// needs.
class AppPrimaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  final IconData? icon;

  const AppPrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.loading = false,
    this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: AppDimens.tapTarget,
      width: double.infinity,
      child: ElevatedButton(
        onPressed: loading ? null : onPressed,
        child: loading
            ? const SizedBox(
                height: 20,
                width: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  valueColor: AlwaysStoppedAnimation(AppColors.onPrimary),
                ),
              )
            : icon == null
                ? Text(label)
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(icon, size: 20),
                      const SizedBox(width: AppSpacing.sm),
                      Text(label),
                    ],
                  ),
      ),
    );
  }
}

/// Secondary/alternate action button -- same 48px minimum height, outlined
/// rather than filled.
class AppSecondaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  const AppSecondaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: AppDimens.tapTarget,
      width: double.infinity,
      child: OutlinedButton(
        onPressed: onPressed,
        child: icon == null
            ? Text(label)
            : Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon, size: 20),
                  const SizedBox(width: AppSpacing.sm),
                  Text(label),
                ],
              ),
      ),
    );
  }
}
