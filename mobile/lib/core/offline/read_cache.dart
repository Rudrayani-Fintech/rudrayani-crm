import 'dart:convert';

import 'package:hive_flutter/hive_flutter.dart';

/// Cache for GET responses the app needs to keep working offline
/// (worklist, customer detail, disposition codes). Distinct from
/// [OfflineQueueNotifier]'s box, which holds outbound writes waiting to
/// sync -- this one holds the last-known-good response for reads.
///
/// Before this existed, worklistProvider/customerByIdProvider/
/// dispositionCodesProvider were plain network-only FutureProviders with no
/// cache at all. Offline, every one of them threw straight to ErrorState --
/// which meant an agent with no signal couldn't even open their worklist to
/// log a call, let alone reach the offline queue's write path (it was
/// sitting behind a screen that could never render). This is what makes
/// the queue reachable at all when it matters most.
class ReadCache {
  static Box<String>? _box;

  static Future<Box<String>> _ensureOpen() async {
    final existing = _box;
    if (existing != null) return existing;
    await Hive.initFlutter();
    final box = await Hive.openBox<String>('read_cache');
    _box = box;
    return box;
  }

  static Future<void> put(String key, dynamic jsonValue) async {
    final box = await _ensureOpen();
    await box.put(key, jsonEncode({'v': jsonValue, 'at': DateTime.now().toIso8601String()}));
  }

  /// Returns null if nothing has ever been cached for this key (e.g. first
  /// launch with no connectivity yet) -- callers should let the original
  /// error surface in that case, since there is nothing to fall back to.
  static Future<dynamic> get(String key) async {
    final box = await _ensureOpen();
    final raw = box.get(key);
    if (raw == null) return null;
    return (jsonDecode(raw) as Map<String, dynamic>)['v'];
  }

  /// When the cached value was written -- lets the UI show "offline —
  /// showing data from HH:MM" instead of presenting stale data as current.
  static Future<DateTime?> cachedAt(String key) async {
    final box = await _ensureOpen();
    final raw = box.get(key);
    if (raw == null) return null;
    final at = (jsonDecode(raw) as Map<String, dynamic>)['at'] as String?;
    return at == null ? null : DateTime.tryParse(at);
  }
}
