import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Consistent loading treatment. A deliberately simple centered spinner +
/// optional label rather than a full shimmer skeleton, which would need a
/// new dependency this app doesn't otherwise carry -- consistent with
/// [AppEmptyState]/[AppErrorState]'s plain style rather than introducing a
/// new visual language.
class AppLoadingState extends StatelessWidget {
  final String? label;
  const AppLoadingState({super.key, this.label});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          if (label != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              label!,
              style: Theme.of(context)
                  .textTheme
                  .bodyMedium
                  ?.copyWith(color: AppColors.textSecondary),
            ),
          ],
        ],
      ),
    );
  }
}

/// Consistent "zero results" treatment for any list/screen -- icon, primary
/// message, optional secondary hint. Distinct from [AppErrorState]: this is
/// for a query that succeeded but has nothing to show, not a failure.
class AppEmptyState extends StatelessWidget {
  final IconData icon;
  final String message;
  final String? hint;
  final Widget? action;
  const AppEmptyState({
    super.key,
    this.icon = Icons.inbox_outlined,
    required this.message,
    this.hint,
    this.action,
  });

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: AppColors.textTertiary),
            const SizedBox(height: AppSpacing.sm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium?.copyWith(color: AppColors.textSecondary),
            ),
            if (hint != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(
                hint!,
                textAlign: TextAlign.center,
                style: textTheme.bodySmall?.copyWith(color: AppColors.textTertiary),
              ),
            ],
            if (action != null) ...[
              const SizedBox(height: AppSpacing.md),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

/// Consistent failure treatment -- icon, message, and an optional retry
/// action sized to the [AppDimens.tapTarget] minimum. Every screen with a
/// provider-backed `.when(error: ...)` branch should render through this
/// instead of an ad hoc `Text('Error: $e')`.
class AppErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  final IconData icon;
  final String retryLabel;
  const AppErrorState({
    super.key,
    required this.message,
    this.onRetry,
    this.icon = Icons.error_outline,
    this.retryLabel = 'Retry',
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: AppColors.error),
            const SizedBox(height: AppSpacing.sm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            if (onRetry != null) ...[
              const SizedBox(height: AppSpacing.md),
              SizedBox(
                height: AppDimens.tapTarget,
                child: OutlinedButton(
                  onPressed: onRetry,
                  child: Text(retryLabel),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Compact inline variant of [AppErrorState] for failures embedded inside a
/// larger scrollable body (e.g. one card among several) rather than a
/// full-screen state -- no centering, tighter padding.
class AppInlineErrorNote extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const AppInlineErrorNote({super.key, required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      child: Row(
        children: [
          const Icon(Icons.error_outline, size: 16, color: AppColors.error),
          const SizedBox(width: AppSpacing.xs),
          Expanded(
            child: Text(
              message,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.error),
            ),
          ),
          if (onRetry != null)
            TextButton(
              onPressed: onRetry,
              child: Text('Retry', style: Theme.of(context).textTheme.bodySmall),
            ),
        ],
      ),
    );
  }
}
