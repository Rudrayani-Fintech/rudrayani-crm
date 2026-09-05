import 'package:hive_flutter/hive_flutter.dart';

/// Per-agent local tally of how often each disposition code has been chosen,
/// backing the Log Visit trail-code pills' most-used-first ordering (§5.1:
/// "Trail code — grouped pills, most-used first"). No backend column exists
/// for this (Phase 11 is mobile-only, per the spec's own file list) and
/// usage frequency is inherently a per-device/per-agent convenience, not
/// data anyone else needs to see -- a local Hive tally, mirroring
/// WorklistFilterStore's own per-store-box pattern, is the simplest option
/// consistent with the rest of the spec (§0.1: "pick the simplest option").
class DispositionUsageStore {
  static Box<int>? _box;

  static Future<Box<int>> _ensureOpen() async {
    final existing = _box;
    if (existing != null) return existing;
    await Hive.initFlutter();
    final box = await Hive.openBox<int>('disposition_usage');
    _box = box;
    return box;
  }

  static Future<void> recordUse(String dispositionCodeId) async {
    final box = await _ensureOpen();
    await box.put(dispositionCodeId, (box.get(dispositionCodeId) ?? 0) + 1);
  }

  /// Snapshot of every recorded count, keyed by disposition code id -- a
  /// code with no recorded use simply has no entry (treat as 0).
  static Future<Map<String, int>> counts() async {
    final box = await _ensureOpen();
    return {for (final k in box.keys.cast<String>()) k: box.get(k) ?? 0};
  }
}

/// Orders codes by descending local usage count, ties broken by keeping the
/// server's own order stable -- extracted as a pure function so the ordering
/// itself has a fast, dependency-free unit test independent of Hive (same
/// rationale as account_repository.dart's accountWorklistCacheKey).
List<T> sortByUsage<T>(List<T> codes, String Function(T) idOf, Map<String, int> usageCounts) {
  final indexed = codes.asMap().entries.toList();
  indexed.sort((a, b) {
    final countA = usageCounts[idOf(a.value)] ?? 0;
    final countB = usageCounts[idOf(b.value)] ?? 0;
    if (countA != countB) return countB.compareTo(countA);
    return a.key.compareTo(b.key); // stable: original order among ties
  });
  return indexed.map((e) => e.value).toList();
}
