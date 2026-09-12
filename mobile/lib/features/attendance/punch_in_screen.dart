import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/tracking/attendance_provider.dart';
import '../../core/tracking/tracking_service.dart';
import '../../core/theme/app_theme.dart';

class PunchInScreen extends ConsumerStatefulWidget {
  const PunchInScreen({super.key});

  @override
  ConsumerState<PunchInScreen> createState() => _PunchInScreenState();
}

class _PunchInScreenState extends ConsumerState<PunchInScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => ref.read(attendanceProvider.notifier).init());
  }

  @override
  Widget build(BuildContext context) {
    final att = ref.watch(attendanceProvider);
    final notifier = ref.read(attendanceProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Punch In Required')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.location_on, size: 64, color: AppColors.primary),
              const SizedBox(height: 24),
              const Text(
                'You must punch in to start your shift and access the app.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 16),
              ),
              const SizedBox(height: 32),
              if (att.error != null) ...[
                Text(
                  att.error!,
                  style: const TextStyle(color: AppColors.error),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 12),
                if (att.needsAppSettings) ...[
                  // A permanently-denied permission means the OS will never
                  // show the prompt again -- without this, tapping Punch In
                  // did nothing, forever, with no way out of the screen.
                  // Background location has the same "no in-app dialog"
                  // problem on Android 11+, so it shares this button --
                  // there's no direct deep link to the Location sub-screen,
                  // only the general app-settings page.
                  const Text(
                    'On the next screen: Permissions → Location → Allow all the time.',
                    style: TextStyle(fontSize: 13, color: AppColors.textSecondary),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: TrackingService.openAppSettings,
                    child: const Text('Open Settings'),
                  ),
                ],
                if (att.needsBatteryAction)
                  // Unlike background location, battery optimization has a
                  // direct OS dialog -- re-run punchIn() right after so the
                  // agent doesn't need a second tap once they grant it.
                  OutlinedButton(
                    onPressed: () async {
                      await TrackingService.requestIgnoreBatteryOptimization();
                      if (context.mounted) notifier.punchIn();
                    },
                    child: const Text('Disable Battery Optimization'),
                  ),
                const SizedBox(height: 16),
              ],
              SizedBox(
                width: double.infinity,
                height: AppDimens.tapTarget,
                child: ElevatedButton(
                  onPressed: att.busy ? null : () => notifier.punchIn(),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: AppColors.onPrimary,
                  ),
                  child: att.busy
                      ? const SizedBox(
                          width: 24,
                          height: 24,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text('Punch In'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
