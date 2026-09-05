import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Persistent duty-status bar shown at the top of every tab (§5.1):
/// on/off-duty state, the running shift timer, a punch button, the offline
/// queue's sync count, and an offline-connectivity alert.
///
/// Purely presentational -- Phase 8 builds the shell only; Phase 10 wires it
/// to `attendanceProvider`/`offlineQueueProvider` and mounts it above the
/// home tabs.
class DutyBar extends StatelessWidget {
  final bool onDuty;
  final Duration shiftDuration;
  final int pendingSyncCount;
  final bool offline;
  final VoidCallback onPunchPressed;

  const DutyBar({
    super.key,
    required this.onDuty,
    required this.shiftDuration,
    required this.onPunchPressed,
    this.pendingSyncCount = 0,
    this.offline = false,
  });

  String _formatDuration(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60);
    return '${h}h ${m}m';
  }

  @override
  Widget build(BuildContext context) {
    final labelStyle = Theme.of(context).textTheme.labelLarge;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: AppDimens.tapTarget),
      child: Container(
        color: onDuty ? AppColors.successContainer : AppColors.neutralContainer,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
        child: Row(
          children: [
            Icon(
              Icons.circle,
              size: 10,
              color: onDuty ? AppColors.success : AppColors.textTertiary,
            ),
            const SizedBox(width: AppSpacing.xs),
            Text(
              onDuty ? 'On duty · ${_formatDuration(shiftDuration)}' : 'Off duty',
              style: labelStyle?.copyWith(
                color: onDuty ? AppColors.successStrong : AppColors.textSecondary,
                fontWeight: FontWeight.w600,
              ),
            ),
            const Spacer(),
            if (offline) ...[
              const Icon(Icons.cloud_off, size: 16, color: AppColors.warningStrong),
              const SizedBox(width: AppSpacing.xs),
            ],
            if (pendingSyncCount > 0) ...[
              Icon(Icons.sync, size: 16, color: AppColors.warningStrong),
              const SizedBox(width: AppSpacing.xs),
              Text(
                '$pendingSyncCount to sync',
                style: labelStyle?.copyWith(color: AppColors.warningStrong),
              ),
              const SizedBox(width: AppSpacing.sm),
            ],
            SizedBox(
              height: AppDimens.tapTarget,
              child: TextButton(
                onPressed: onPunchPressed,
                child: Text(onDuty ? 'Punch Out' : 'Punch In'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
