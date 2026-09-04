import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'tracking_task.dart';

/// Previously `denied` (can just ask again) and `deniedForever` (the OS will
/// never show the prompt again -- only Settings can fix it) were collapsed
/// into one message with no way to act on the second case. After a
/// permanent denial, tapping Punch In did nothing, forever.
enum LocationPermissionIssue { none, servicesDisabled, deniedTemporarily, deniedForever }

/// UI-side control of the background tracking foreground service.
/// Punch-in starts it, punch-out stops it (brief §10: explicit, not implicit).
class TrackingService {
  /// Call once in main() before runApp.
  static void initCommunicationPort() => FlutterForegroundTask.initCommunicationPort();

  /// Notification + location permissions. The service is started while the
  /// app is in the foreground, so a `location`-type foreground service keeps
  /// GPS access in the background with plain while-in-use permission —
  /// no "Allow all the time" settings trip needed.
  static Future<LocationPermissionIssue> ensurePermissions() async {
    await FlutterForegroundTask.requestNotificationPermission();

    if (!await Geolocator.isLocationServiceEnabled()) {
      return LocationPermissionIssue.servicesDisabled;
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.deniedForever) {
      return LocationPermissionIssue.deniedForever;
    }
    if (perm == LocationPermission.denied) {
      return LocationPermissionIssue.deniedTemporarily;
    }
    return LocationPermissionIssue.none;
  }

  static String messageFor(LocationPermissionIssue issue) => switch (issue) {
        LocationPermissionIssue.servicesDisabled => 'Turn on device location (GPS) to punch in.',
        LocationPermissionIssue.deniedTemporarily =>
          'Location permission is required to punch in.',
        LocationPermissionIssue.deniedForever =>
          "Location permission was permanently denied. Open Settings to enable it — this app can't ask again.",
        LocationPermissionIssue.none => '',
      };

  /// Wraps geolocator's settings deep-link so the UI layer never imports
  /// geolocator directly -- kept consistent with the rest of this class.
  static Future<void> openAppSettings() => Geolocator.openAppSettings();

  /// X2: without this, MIUI/ColorOS/FuntouchOS/One UI throttle or kill the
  /// tracking foreground service in the background. Best-effort -- the OS
  /// dialog can be dismissed, and older/other OEMs may not show it at all,
  /// so this never blocks punch-in on the outcome.
  static Future<void> requestIgnoreBatteryOptimization() async {
    try {
      if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
        await FlutterForegroundTask.requestIgnoreBatteryOptimization();
      }
    } catch (_) {
      // Not fatal to punch-in -- tracking still runs, just less reliably
      // backgrounded on OEMs that aggressively throttle it.
    }
  }

  /// Null means no fix could be obtained at all (fresh or cached) -- callers
  /// (punch-in/out) should proceed without coordinates rather than block,
  /// matching field_visit_screen.dart's existing fallback pattern. Without
  /// this, a 30s GPS timeout (indoors, basement office, cold GPS start)
  /// threw straight out of punch-in and trapped the agent on that screen
  /// with nothing to do but keep retrying.
  static Future<Position?> currentPosition() async {
    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 30),
        ),
      );
    } catch (_) {
      try {
        return await Geolocator.getLastKnownPosition();
      } catch (_) {
        return null;
      }
    }
  }

  static Future<void> start({required int pingIntervalSeconds}) async {
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'rudrayani_tracking',
        channelName: 'Duty location tracking',
        channelDescription: 'Shown while you are punched in',
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.repeat(pingIntervalSeconds * 1000),
        allowWakeLock: true,
        autoRunOnBoot: false,
      ),
    );
    if (await FlutterForegroundTask.isRunningService) return;
    await FlutterForegroundTask.startService(
      serviceId: 100,
      serviceTypes: [ForegroundServiceTypes.location],
      notificationTitle: 'On duty — location tracking active',
      notificationText: 'Rudrayani CRM records your route until you punch out',
      callback: startTrackingCallback,
    );
  }

  static Future<void> stop() async {
    if (await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.stopService();
    }
  }

  static Future<bool> get isRunning => FlutterForegroundTask.isRunningService;
}
