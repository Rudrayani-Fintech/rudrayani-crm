import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../api/api_client.dart';
import '../models/account.dart';
import '../offline/offline_queue.dart';
import '../offline/read_cache.dart';
import '../offline/worklist_filter_store.dart';

/// Whether the data currently shown by [AccountRepository] reads came from
/// the offline cache rather than a fresh network response -- WorklistScreen
/// uses this to show "offline — showing cached data" instead of presenting
/// a stale list as live. Kept as its own provider (rather than a repository
/// field) so screens can watch it independently of any particular fetch.
final worklistIsStaleProvider = StateProvider<bool>((ref) => false);


/// Builds an unambiguous offline-read-cache key for a given scope + filter
/// selection. A naive `list.join('_')` let two different selections
/// collide onto the same key whenever a branch/bucket name itself
/// contained an underscore (e.g. branches: ["A","B"] and branches: ["A_B"]
/// both joined to "A_B") -- on the offline-fallback path that could
/// silently serve a cached list for the wrong filter combination. One
/// control character separates names *within* a branch/bucket list;
/// another separates the three top-level segments (scope, branches,
/// buckets). Both are control characters that can never appear in a real
/// branch/bucket name, and using two *distinct* separators (rather than
/// one) also rules out the boundary shifting between segments -- e.g.
/// branches: ["A","B"], buckets: ["C"] vs. branches: ["A"],
/// buckets: ["B","C"] would still collide if one separator alone joined
/// everything flat, since both reduce to the same token stream with no
/// marker for where the branches group ends and the buckets group begins.
///
/// Extracted as a top-level function (rather than a private repository
/// method) so it has a fast, dependency-free unit test independent of
/// Hive/ApiClient -- see `test/account_repository_test.dart`. Real Hive
/// boxes need platform channels that aren't mockable anywhere in this test
/// suite (see the note in `test/offline_queue_test.dart`), so the
/// network-then-cache-fallback behaviour itself isn't covered by an
/// automated test; this locks in the one piece of that logic that's pure.
String accountWorklistCacheKey(String scope, WorklistFilterSelection filters) {
  const itemSep = '';
  const groupSep = '';
  final segments = [scope, filters.branches.join(itemSep), filters.buckets.join(itemSep)];
  return 'worklist_${segments.join(groupSep)}';
}

/// One owner for every `Account` read and write (§7.2) -- screens never
/// touch `Dio`/`ApiClient` directly for account data. Generalizes the
/// fetch-with-cache-fallback pattern (and the collision-safe cache-key
/// scheme) that used to be hand-rolled separately in
/// `worklist_provider.dart`'s `_fetchWithCacheFallback`/`_worklistCacheKey`.
/// Writes are NOT re-implemented here -- they're delegated to the existing
/// [OfflineQueueNotifier], which already has a solid, type-tagged,
/// dead-letter-aware retry mechanism; building a second write-queue would
/// just be two places to get money-critical persistence right instead of
/// one.
class AccountRepository {
  final Ref _ref;
  const AccountRepository(this._ref);

  ApiClient get _api => _ref.read(apiClientProvider);

  Future<List<Map<String, dynamic>>> _fetchWithCacheFallback(
    String cacheKey,
    Future<List<Map<String, dynamic>>> Function() fetch,
  ) async {
    try {
      final list = await fetch();
      await ReadCache.put(cacheKey, list);
      _ref.read(worklistIsStaleProvider.notifier).state = false;
      return list;
    } catch (e) {
      final cached = await ReadCache.get(cacheKey);
      if (cached == null) rethrow;
      _ref.read(worklistIsStaleProvider.notifier).state = true;
      return (cached as List).cast<Map<String, dynamic>>();
    }
  }

  /// The assigned-accounts list (`GET /worklist`), scope- and filter-aware,
  /// falling back to the last cached response offline.
  Future<List<Account>> fetchWorklist({
    required String scope,
    required WorklistFilterSelection filters,
  }) async {
    final query = <String, dynamic>{};
    if (scope == 'team') query['scope'] = 'team';
    if (filters.branches.isNotEmpty) query['customer_branch'] = filters.branches.join(',');
    if (filters.buckets.isNotEmpty) query['bucket'] = filters.buckets.join(',');
    final cacheKey = accountWorklistCacheKey(scope, filters);
    final list = await _fetchWithCacheFallback(cacheKey, () async {
      final res = await _api.get<Map<String, dynamic>>(
        '/worklist',
        query: query.isEmpty ? null : query,
      );
      return (res.data!['customers'] as List).cast<Map<String, dynamic>>();
    });
    return list.map(Account.fromJson).toList();
  }

  /// One assigned account by id (`GET /worklist/:id`) -- backs the detail
  /// screen and its children (call log / payment / PTPs / field visit),
  /// which navigate by id rather than carrying the object across routes
  /// (go_router's `extra` doesn't survive an app restart or a cold deep
  /// link). Falls back to the last cached response offline.
  Future<Account> fetchById(String id) async {
    final cacheKey = 'account_$id';
    try {
      final res = await _api.get<Map<String, dynamic>>('/worklist/$id');
      final json = res.data!['customer'] as Map<String, dynamic>;
      await ReadCache.put(cacheKey, json);
      return Account.fromJson(json);
    } catch (e) {
      final cached = await ReadCache.get(cacheKey);
      if (cached == null) rethrow;
      return Account.fromJson((cached as Map).cast<String, dynamic>());
    }
  }

  /// Queues a write (call log, payment, field visit, reminder, attachment,
  /// punch in/out) for the existing offline queue to sync -- the one door
  /// every account-related write goes through, network or not.
  Future<void> enqueueWrite(QueuedAction action) {
    return _ref.read(offlineQueueProvider.notifier).enqueue(action);
  }
}

final accountRepositoryProvider = Provider<AccountRepository>((ref) => AccountRepository(ref));
