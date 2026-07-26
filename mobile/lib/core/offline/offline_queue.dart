import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:hive_flutter/hive_flutter.dart';
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../api/api_client.dart';

/// An item stays queued and is retried after a transient failure (network
/// blip, 5xx) up to this many times before it's parked as a dead letter —
/// visible to the agent, no longer auto-retried, but never silently dropped.
const int maxAutoRetries = 8;

/// Durable offline queue for money-critical actions (brief §8: "queue actions
/// locally, sync when connectivity returns"). Each item carries a client_key
/// UUID; the server answers a re-send with the already-created row, so a
/// half-synced queue can always be flushed again safely.
class QueuedAction {
  final String clientKey;
  final String
  type; // 'call_log' | 'payment' | 'field_visit' | 'reminder' | 'attachment'
  final Map<String, dynamic> payload;
  final String? photoPath; // durable copy for queued payments/visits
  final DateTime createdAt;
  final int retryCount;
  final bool deadLetter;

  QueuedAction({
    required this.clientKey,
    required this.type,
    required this.payload,
    this.photoPath,
    required this.createdAt,
    this.retryCount = 0,
    this.deadLetter = false,
  });

  QueuedAction withRetry({required bool deadLetter}) => QueuedAction(
    clientKey: clientKey,
    type: type,
    payload: payload,
    photoPath: photoPath,
    createdAt: createdAt,
    retryCount: retryCount + 1,
    deadLetter: deadLetter,
  );

  Map<String, dynamic> toJson() => {
    'client_key': clientKey,
    'type': type,
    'payload': payload,
    'photo_path': photoPath,
    'created_at': createdAt.toIso8601String(),
    'retry_count': retryCount,
    'dead_letter': deadLetter,
  };

  // Items queued before 2026-07-06 may still carry a 'signature_path' key
  // (signature capture removed) — it is simply ignored here.
  factory QueuedAction.fromJson(Map<String, dynamic> j) => QueuedAction(
    clientKey: j['client_key'] as String,
    type: j['type'] as String,
    payload: Map<String, dynamic>.from(j['payload'] as Map),
    photoPath: j['photo_path'] as String?,
    createdAt: DateTime.parse(j['created_at'] as String),
    retryCount: (j['retry_count'] as num?)?.toInt() ?? 0,
    deadLetter: j['dead_letter'] as bool? ?? false,
  );
}

class OfflineQueueState {
  final int pending;
  final bool syncing;
  final String? lastError; // last permanent rejection, shown once to the agent
  final List<QueuedAction> items; // full contents, for a "what's pending" view

  const OfflineQueueState({
    this.pending = 0,
    this.syncing = false,
    this.lastError,
    this.items = const [],
  });

  int get deadLetterCount => items.where((i) => i.deadLetter).length;

  OfflineQueueState copyWith({
    int? pending,
    bool? syncing,
    String? lastError,
    List<QueuedAction>? items,
  }) => OfflineQueueState(
    pending: pending ?? this.pending,
    syncing: syncing ?? this.syncing,
    lastError: lastError,
    items: items ?? this.items,
  );
}

class OfflineQueueNotifier extends StateNotifier<OfflineQueueState> {
  final Ref ref;
  Box<String>? _box;
  final Completer<void> _ready = Completer<void>();
  static const _uuid = Uuid();

  OfflineQueueNotifier(this.ref) : super(const OfflineQueueState()) {
    _init();
  }

  Future<void> _init() async {
    await Hive.initFlutter();
    _box = await Hive.openBox<String>('offline_actions');
    _ready.complete();
    _syncStateFromBox();
    // Flush whenever connectivity comes back (and once at startup).
    Connectivity().onConnectivityChanged.listen((results) {
      if (results.any((r) => r != ConnectivityResult.none)) flush();
    });
    flush();
  }

  static String newClientKey() => _uuid.v4();

  /// Copies a picked photo out of the image_picker cache (which the OS may
  /// clear) into the app documents dir so a queued payment keeps its proof.
  static Future<String> persistPhoto(String cachePath) async {
    final dir = await getApplicationDocumentsDirectory();
    final ext = cachePath.split('.').last;
    final dest = '${dir.path}/queued_${_uuid.v4()}.$ext';
    await File(cachePath).copy(dest);
    return dest;
  }

  /// Waits for Hive to finish opening before writing. Without this, an
  /// enqueue() called in the first moments after app start (before _init()
  /// resolves) would silently no-op against a null box — the caller shows
  /// "saved offline" while nothing was actually persisted. Throws instead of
  /// silently succeeding if the box never becomes available.
  Future<void> enqueue(QueuedAction action) async {
    await _ready.future;
    final box = _box;
    if (box == null) {
      throw StateError('Offline storage is unavailable — action not saved.');
    }
    await box.put(action.clientKey, jsonEncode(action.toJson()));
    _syncStateFromBox();
  }

  List<QueuedAction> _readItems(Box<String> box) =>
      box.values
          .map((s) => QueuedAction.fromJson(jsonDecode(s) as Map<String, dynamic>))
          .toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt));

  void _syncStateFromBox() {
    final box = _box;
    if (box == null) return;
    final items = _readItems(box);
    state = state.copyWith(pending: items.length, items: items);
  }

  /// Sends everything in FIFO order.
  ///
  /// - Still offline (network-level failure): stop entirely, keep everything
  ///   queued including the item in flight.
  /// - Permanent rejection (4xx — validation, closed customer, retired
  ///   code): drop the item so it can't block the queue forever, surface why.
  /// - Transient failure (5xx, unexpected error shape): keep the item and
  ///   retry on the next flush, up to [maxAutoRetries]; after that it's
  ///   parked as a dead letter — still visible and still synced manually,
  ///   never silently deleted just because the server had a bad moment.
  Future<void> flush() async {
    final box = _box;
    if (box == null || box.isEmpty || state.syncing) return;
    state = state.copyWith(syncing: true);
    final api = ref.read(apiClientProvider);

    try {
      final items = _readItems(box).where((i) => !i.deadLetter).toList();

      final rejections = <String>[];
      for (final item in items) {
        try {
          if (item.type == 'call_log') {
            await api.post('/call-logs', data: item.payload);
          } else if (item.type == 'payment') {
            final form = FormData.fromMap({
              ...item.payload,
              if (item.photoPath != null && File(item.photoPath!).existsSync())
                'photo': await MultipartFile.fromFile(
                  item.photoPath!,
                  filename: 'proof.jpg',
                ),
            });
            await api.postForm('/payments', form);
          } else if (item.type == 'field_visit') {
            final form = FormData.fromMap({
              ...item.payload,
              if (item.photoPath != null && File(item.photoPath!).existsSync())
                'photo': await MultipartFile.fromFile(
                  item.photoPath!,
                  filename: 'visit.jpg',
                ),
            });
            await api.postForm('/field-visits', form);
          } else if (item.type == 'reminder') {
            await api.post('/reminders', data: item.payload);
          } else if (item.type == 'attachment') {
            final form = FormData.fromMap({
              ...item.payload,
              if (item.photoPath != null && File(item.photoPath!).existsSync())
                'file': await MultipartFile.fromFile(
                  item.photoPath!,
                  filename: 'photo.jpg',
                ),
            });
            await api.postForm('/attachments', form);
          }
          await _remove(box, item);
        } on DioException catch (e) {
          if (_isOffline(e)) return; // still offline — keep everything queued
          final label = switch (item.type) {
            'payment' => 'Payment',
            'field_visit' => 'Field visit',
            'reminder' => 'Reminder',
            'attachment' => 'Document',
            _ => 'Call log',
          };
          if (_isPermanentRejection(e)) {
            rejections.add(
              '$label could not sync: '
              '${e.response?.data?['error'] ?? e.response?.statusCode ?? e.message}',
            );
            await _remove(box, item);
          } else {
            // Transient (5xx / unknown) — never delete on a server hiccup.
            // Retain and bump the retry count; park as a dead letter once
            // the item has failed too many times to keep retrying silently.
            final next = item.withRetry(
              deadLetter: item.retryCount + 1 >= maxAutoRetries,
            );
            await box.put(next.clientKey, jsonEncode(next.toJson()));
            if (next.deadLetter) {
              rejections.add(
                '$label failed to sync after $maxAutoRetries attempts and needs review.',
              );
            }
          }
        }
      }
      if (rejections.isNotEmpty) {
        state = state.copyWith(lastError: rejections.join('\n'));
      }
    } finally {
      _syncStateFromBox();
      state = state.copyWith(syncing: false, lastError: state.lastError);
    }
  }

  Future<void> _remove(Box<String> box, QueuedAction item) async {
    await box.delete(item.clientKey);
    if (item.photoPath != null) {
      try {
        await File(item.photoPath!).delete();
      } catch (_) {
        // already gone — nothing to clean up
      }
    }
  }

  /// Manually removes a dead-letter item the agent has reviewed (e.g. after
  /// confirming with a manager it should be discarded).
  Future<void> discard(String clientKey) async {
    final box = _box;
    if (box == null) return;
    final raw = box.get(clientKey);
    if (raw == null) return;
    await _remove(box, QueuedAction.fromJson(jsonDecode(raw) as Map<String, dynamic>));
    _syncStateFromBox();
  }

  void clearError() => state = state.copyWith(lastError: null);

  static bool _isOffline(DioException e) =>
      e.type == DioExceptionType.connectionError ||
      e.type == DioExceptionType.connectionTimeout ||
      e.type == DioExceptionType.sendTimeout ||
      e.type == DioExceptionType.receiveTimeout ||
      (e.type == DioExceptionType.unknown && e.error is SocketException);

  /// A 4xx response is the server explicitly rejecting the record (bad
  /// data, closed customer, retired disposition code) — retrying it won't
  /// help, so it's safe to drop after surfacing why. Anything else with a
  /// response (5xx) or no response at all (that isn't a recognized offline
  /// error) is treated as transient and retried instead of deleted.
  static bool _isPermanentRejection(DioException e) {
    final status = e.response?.statusCode;
    return status != null && status >= 400 && status < 500;
  }
}

final offlineQueueProvider =
    StateNotifierProvider<OfflineQueueNotifier, OfflineQueueState>(
      (ref) => OfflineQueueNotifier(ref),
    );

/// True when this Dio failure means "no connectivity" — the caller should
/// queue the action instead of showing an error.
bool isOfflineError(Object e) =>
    e is DioException && OfflineQueueNotifier._isOffline(e);
