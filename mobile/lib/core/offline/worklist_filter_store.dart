import 'package:hive_flutter/hive_flutter.dart';

/// Selected branch/bucket worklist filter -- multi-select, persisted
/// per-user so it survives app restarts. Mirrors read_cache.dart's
/// per-store-box pattern (its own Hive box, not shared with the offline
/// read cache or the offline action queue).
class WorklistFilterSelection {
  final List<String> branches;
  final List<String> buckets;
  const WorklistFilterSelection({this.branches = const [], this.buckets = const []});
}

class WorklistFilterStore {
  static Box<String>? _box;

  static Future<Box<String>> _ensureOpen() async {
    final existing = _box;
    if (existing != null) return existing;
    await Hive.initFlutter();
    final box = await Hive.openBox<String>('worklist_filters');
    _box = box;
    return box;
  }

  static Future<WorklistFilterSelection> load(String userId) async {
    final box = await _ensureOpen();
    final branches = box.get('${userId}_branches')?.split('|').where((s) => s.isNotEmpty).toList() ?? [];
    final buckets = box.get('${userId}_buckets')?.split('|').where((s) => s.isNotEmpty).toList() ?? [];
    return WorklistFilterSelection(branches: branches, buckets: buckets);
  }

  static Future<void> save(String userId, WorklistFilterSelection selection) async {
    final box = await _ensureOpen();
    await box.put('${userId}_branches', selection.branches.join('|'));
    await box.put('${userId}_buckets', selection.buckets.join('|'));
  }
}
