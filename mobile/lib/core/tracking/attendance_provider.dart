import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../api/api_client.dart';
import '../auth/auth_provider.dart';
import '../offline/read_cache.dart';
import 'tracking_service.dart';

class AttendanceState {
  final bool punchedIn;
  final DateTime? punchInAt;
  final bool busy;
  final String? error;
  /// True when [error] is a permanent location-permission denial -- the OS
  /// will never show the permission prompt again, so the only way forward
  /// is the "Open Settings" action the punch-in screen shows for this case.
  final bool needsAppSettings;

  const AttendanceState({
    this.punchedIn = false,
    this.punchInAt,
    this.busy = false,
    this.error,
    this.needsAppSettings = false,
  });

  AttendanceState copyWith({
    bool? punchedIn,
    DateTime? punchInAt,
    bool? busy,
    String? error,
    bool needsAppSettings = false,
  }) =>
      AttendanceState(
        punchedIn: punchedIn ?? this.punchedIn,
        punchInAt: punchInAt ?? this.punchInAt,
        busy: busy ?? this.busy,
        error: error,
        needsAppSettings: needsAppSettings,
      );
}

/// Punch state + the tracking service that follows it (brief §10: punch-in
/// starts the tracking session, punch-out ends it — explicit in the UI).
class AttendanceNotifier extends StateNotifier<AttendanceState> {
  final Ref ref;
  AttendanceNotifier(this.ref) : super(const AttendanceState());

  ApiClient get _api => ref.read(apiClientProvider);

  Future<int> _pingIntervalSeconds() async {
    try {
      final res = await _api.get('/location/config');
      return (res.data['ping_interval_seconds'] as num).toInt();
    } catch (_) {
      return 120; // brief §9 default
    }
  }

  /// A telecaller who is not also a field agent never leaves the office --
  /// there is nothing meaningful to track, so they should never be blocked
  /// by (or asked for) a location permission at all. A user with both
  /// capabilities still needs it for their field work.
  bool get _exemptFromGps {
    final auth = ref.read(authProvider.notifier);
    return auth.isTelecaller && !auth.isFieldAgent;
  }

  /// Reconcile app + service state with the server on startup: a reinstalled
  /// or force-stopped app resumes tracking if the shift is still open.
  ///
  /// Punch state was never persisted locally -- offline at startup used to
  /// leave `punchedIn` at its default (false), which the router treats as
  /// "must punch in" and hard-locks the whole app behind that screen. An
  /// agent who punched in that morning and lost signal by midday would be
  /// wrongly trapped there until connectivity returned, even mid-shift.
  /// Falling back to the last known status instead of a hardcoded default
  /// fixes that.
  Future<void> init() async {
    try {
      final data = (await _api.get('/attendance/status')).data as Map<String, dynamic>;
      await ReadCache.put('attendance_status', data);
      await _applyStatus(data);
    } catch (_) {
      final cached = await ReadCache.get('attendance_status');
      if (cached != null) {
        await _applyStatus((cached as Map).cast<String, dynamic>());
      }
      // No cache and offline (first-ever launch with no connectivity) --
      // nothing to reconcile against; punch-in itself still works and will
      // establish real state once it succeeds.
    }
  }

  Future<void> _applyStatus(Map<String, dynamic> data) async {
    final punchedIn = data['punched_in'] == true;
    final punchInAt = punchedIn
        ? DateTime.tryParse(data['attendance']?['punch_in_at'] ?? '')
        : null;
    state = state.copyWith(punchedIn: punchedIn, punchInAt: punchInAt);

    if (_exemptFromGps) return;

    final running = await TrackingService.isRunning;
    if (punchedIn && !running) {
      final issue = await TrackingService.ensurePermissions();
      if (issue == LocationPermissionIssue.none) {
        await TrackingService.start(pingIntervalSeconds: await _pingIntervalSeconds());
      }
    } else if (!punchedIn && running) {
      await TrackingService.stop();
    }
  }

  Future<void> punchIn() async {
    state = state.copyWith(busy: true, error: null);
    try {
      if (_exemptFromGps) {
        final res = await _api.post('/attendance/punch-in', data: const {});
        state = state.copyWith(
          punchedIn: true,
          punchInAt: DateTime.tryParse(res.data['attendance']?['punch_in_at'] ?? ''),
          busy: false,
        );
        return;
      }

      final issue = await TrackingService.ensurePermissions();
      if (issue != LocationPermissionIssue.none) {
        state = state.copyWith(
          busy: false,
          error: TrackingService.messageFor(issue),
          needsAppSettings: issue == LocationPermissionIssue.deniedForever,
        );
        return;
      }
      // No fix (fresh or cached) is no longer fatal -- the server accepts a
      // punch-in with coordinates omitted rather than blocking the agent
      // indoors or on a cold GPS start.
      final pos = await TrackingService.currentPosition();
      final res = await _api.post('/attendance/punch-in', data: {
        if (pos != null) 'lat': pos.latitude,
        if (pos != null) 'lng': pos.longitude,
      });
      await TrackingService.start(pingIntervalSeconds: await _pingIntervalSeconds());
      state = state.copyWith(
        punchedIn: true,
        punchInAt: DateTime.tryParse(res.data['attendance']?['punch_in_at'] ?? ''),
        busy: false,
      );
    } on DioException catch (e) {
      if (e.response?.statusCode == 409) {
        // Server already has an open shift — adopt it and start tracking.
        await init();
        state = state.copyWith(busy: false);
      } else {
        state = state.copyWith(busy: false, error: _friendlyError(e));
      }
    } catch (e) {
      state = state.copyWith(busy: false, error: _friendlyError(e));
    }
  }

  Future<void> punchOut() async {
    state = state.copyWith(busy: true, error: null);
    try {
      if (_exemptFromGps) {
        await _api.post('/attendance/punch-out', data: const {});
        state = const AttendanceState();
        return;
      }
      final pos = await TrackingService.currentPosition();
      await _api.post('/attendance/punch-out', data: {
        if (pos != null) 'lat': pos.latitude,
        if (pos != null) 'lng': pos.longitude,
      });
      await TrackingService.stop();
      state = const AttendanceState();
    } on DioException catch (e) {
      if (e.response?.statusCode == 409) {
        // No open shift server-side — just stop the local service.
        await TrackingService.stop();
        state = const AttendanceState();
      } else {
        state = state.copyWith(busy: false, error: _friendlyError(e));
      }
    } catch (e) {
      state = state.copyWith(busy: false, error: _friendlyError(e));
    }
  }

  /// A bare `'Punch-in failed: $e'` used to put raw exception text on screen
  /// (e.g. "Punch-in failed: TimeoutException after 0:00:30.000000: ...").
  static String _friendlyError(Object e) {
    if (e is DioException) {
      if (e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.receiveTimeout ||
          e.type == DioExceptionType.connectionError) {
        return 'No network connection — try again once you have signal.';
      }
      final serverMsg = e.response?.data is Map ? e.response?.data['error'] as String? : null;
      return serverMsg ?? 'Something went wrong. Please try again.';
    }
    if (e.toString().contains('TimeoutException')) {
      return 'Could not get a GPS fix in time. Try again, or move somewhere with a clearer view of the sky.';
    }
    return 'Something went wrong. Please try again.';
  }
}

final attendanceProvider = StateNotifierProvider<AttendanceNotifier, AttendanceState>(
  (ref) => AttendanceNotifier(ref),
);
