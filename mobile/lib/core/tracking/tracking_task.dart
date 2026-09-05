import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'package:hive_flutter/hive_flutter.dart';
import 'package:intl/intl.dart';
import '../api/api_client.dart';

/// Entry point for the foreground-service isolate. Must be a top-level
/// function kept by the AOT compiler, hence the pragma.
@pragma('vm:entry-point')
void startTrackingCallback() {
  FlutterForegroundTask.setTaskHandler(TrackingTaskHandler());
}

/// Captures a GPS ping on every repeat tick (interval comes from
/// /api/location/config, default 2 min — brief §9) and posts the batch.
/// Pings that fail to send (offline) are persisted in a Hive box owned by
/// this isolate — they survive punch-out, app kills, and reboots, and ride
/// along with the next batch. The server ignores duplicate
/// (user_id, recorded_at) rows, so re-sends are always safe.
class TrackingTaskHandler extends TaskHandler {
  // Built in onStart, not as a field initializer: this isolate has its own
  // memory space (a fresh copy of every top-level/static variable), so the
  // server-URL override cached in the UI isolate is NOT visible here — it
  // must be re-loaded from secure storage before Dio is constructed, or a
  // release-build tracking service would silently ping the debug default.
  late final Dio _dio;
  final List<Map<String, dynamic>> _pending = [];
  Box<String>? _box;

  static const _maxPending = 300; // ~10 hours at 2-min pings
  static const _boxKey = 'items';

  Future<void> _openStore() async {
    // This box is opened ONLY in the tracking isolate; the UI isolate uses
    // its own 'offline_actions' box — Hive boxes must not cross isolates.
    await Hive.initFlutter();
    _box = await Hive.openBox<String>('pending_pings');
    final saved = _box!.get(_boxKey);
    if (saved != null) {
      final items = (jsonDecode(saved) as List).cast<Map<String, dynamic>>();
      _pending.addAll(items);
    }
  }

  Future<void> _persistPending() async {
    if (_pending.isEmpty) {
      await _box?.delete(_boxKey);
    } else {
      await _box?.put(_boxKey, jsonEncode(_pending));
    }
  }

  Future<void> _capturePing() async {
    try {
      Position pos;
      try {
        pos = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high,
            timeLimit: Duration(seconds: 30),
          ),
        );
      } catch (_) {
        // X2: a high-accuracy fix is all-or-nothing -- indoors that's
        // silence rather than a degraded fix. Retry once at a lower
        // accuracy/shorter timeout before giving up the tick entirely.
        pos = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.medium,
            timeLimit: Duration(seconds: 15),
          ),
        );
      }
      _pending.add({
        // X2: location_pings has a unique (user_id, recorded_at) index with
        // ON CONFLICT DO NOTHING. Using the GPS fix's own timestamp means a
        // repeated cached fix (same pos.timestamp) is silently discarded --
        // stamp with wall-clock time instead so every tick is recorded.
        'recorded_at': DateTime.now().toUtc().toIso8601String(),
        'lat': pos.latitude,
        'lng': pos.longitude,
        'accuracy_meters': pos.accuracy,
      });
    } catch (_) {
      // GPS unavailable this tick (indoors, timeout) — try again next tick.
    }
    if (_pending.isEmpty) return;
    if (_pending.length > _maxPending) {
      _pending.removeRange(0, _pending.length - _maxPending);
    }
    await _flush(updateNotification: true);
  }

  Future<void> _flush({required bool updateNotification}) async {
    try {
      await _dio.post('/location/pings', data: {'pings': List.of(_pending)});
      _pending.clear();
      if (updateNotification) {
        FlutterForegroundTask.updateService(
          notificationText:
              'Last ping ${DateFormat('HH:mm').format(DateTime.now())} — punch out to stop',
        );
      }
    } catch (_) {
      if (updateNotification) {
        FlutterForegroundTask.updateService(
          notificationText:
              '${_pending.length} ping(s) queued, will sync when online',
        );
      }
    }
    await _persistPending();
  }

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    await loadServerUrlOverride();
    _dio = buildDio();
    await _openStore();
    await _capturePing();
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    _capturePing();
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    // Best-effort flush; anything still unsent is persisted and goes out
    // with the first ping of the next shift.
    if (_pending.isNotEmpty) {
      await _flush(updateNotification: false);
    }
  }
}
