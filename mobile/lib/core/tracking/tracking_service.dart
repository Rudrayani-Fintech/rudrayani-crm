import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'tracking_task.dart';

/// Previously `denied` (can just ask again) and `deniedForever` (the OS will
/// never show the prompt again -- only Settings can fix it) were collapsed
/// into one message with no way to act on the second case. After a
/// permanent denial, tapping Punch In did nothing, forever.
///
/// `backgroundNotGranted` and `batteryOptimizationOn` are both blocking, per
/// the decision to require "Allow all the time" + battery optimization
/// disabled rather than the previous while-in-use-only, best-effort setup.
enum LocationPermissionIssue {
  none,
  servicesDisabled,
  deniedTemporarily,
  deniedForever,
  backgroundNotGranted,
  batteryOptimizationOn,
}

/// UI-side control of the background tracking foreground service.
/// Punch-in starts it, punch-out stops it (brief §10: explicit, not implicit).
class TrackingService {
  /// Call once in main() before runApp.
  static void initCommunicationPort() => FlutterForegroundTask.initCommunicationPort();

  /// Notification + location permissions. Tracking must survive the app
  /// going to the background for the whole shift, not just while it's the
  /// foreground app -- so this now requires `always` (background) location
  /// and battery-optimization exemption, both blocking. Each check
  /// short-circuits on the first unmet requirement, so the punch-in screen
  /// only ever shows one actionable message at a time.
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
    // On Android 11+, requestPermission() cannot itself grant `always` --
    // there is no in-app dialog for it; the OS dialog only offers
    // while-in-use here. Getting anything less than `always` means the
    // agent still needs to visit Settings manually.
    if (perm != LocationPermission.always) {
      return LocationPermissionIssue.backgroundNotGranted;
    }
    if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
      return LocationPermissionIssue.batteryOptimizationOn;
    }
    return LocationPermissionIssue.none;
  }

  static String messageFor(LocationPermissionIssue issue) => switch (issue) {
        LocationPermissionIssue.servicesDisabled => 'Turn on device location (GPS) to punch in.',
        LocationPermissionIssue.deniedTemporarily =>
          'Location permission is required to punch in.',
        LocationPermissionIssue.deniedForever =>
          "Location permission was permanently denied. Open Settings to enable it — this app can't ask again.",
        LocationPermissionIssue.backgroundNotGranted =>
          'Location access is only allowed "while using the app." Field tracking needs '
              '"Allow all the time" -- open Settings, then Permissions → Location → '
              'Allow all the time.',
        LocationPermissionIssue.batteryOptimizationOn =>
          'Battery optimization for this app must be turned off so tracking keeps running '
              'in the background.',
        LocationPermissionIssue.none => '',
      };

  /// deniedForever and backgroundNotGranted both need a trip to Settings --
  /// geolocator has no direct deep link to the Location permission
  /// sub-screen, only the app's general settings page.
  static bool needsSettingsNavigation(LocationPermissionIssue issue) =>
      issue == LocationPermissionIssue.deniedForever ||
      issue == LocationPermissionIssue.backgroundNotGranted;

  /// Battery optimization, unlike background location, has a direct OS
  /// dialog (requestIgnoreBatteryOptimization() below) -- no Settings trip.
  static bool needsBatteryAction(LocationPermissionIssue issue) =>
      issue == LocationPermissionIssue.batteryOptimizationOn;

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
