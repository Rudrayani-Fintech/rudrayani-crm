import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_client.dart';
import '../../core/data/account_repository.dart';
import '../../core/models/customer.dart';
import '../../core/offline/read_cache.dart';
import '../../core/offline/worklist_filter_store.dart';

export '../../core/data/account_repository.dart' show worklistIsStaleProvider;

/// Personal (own allocations) vs Team (every allocation in the branch a
/// branch_manager manages) -- the web equivalent is MyWorklistPage.tsx's
/// Segmented control. Only a branch_manager gets a toggle for this in the
/// UI (see WorklistScreen); everyone else always resolves to personal scope
/// server-side regardless of what this holds.
final worklistScopeProvider = StateProvider<String>((ref) => 'personal');

/// Selected branch/bucket filter -- starts empty (show all); WorklistScreen
/// loads the persisted selection for the current user on first build and
/// writes it back here via the notifier whenever the agent changes it.
final worklistFiltersProvider = StateProvider<WorklistFilterSelection>((ref) => const WorklistFilterSelection());

/// Options for the filter chips -- scoped to this agent's own allocated
/// customers (web equivalent: GET /worklist/filter-options), not the
/// agency-wide branch/bucket admin lists.
final worklistFilterOptionsProvider = FutureProvider<({List<String> branches, List<String> buckets})>((ref) async {
  final api = ref.watch(apiClientProvider);
  final scope = ref.watch(worklistScopeProvider);
  final res = await api.get<Map<String, dynamic>>(
    '/worklist/filter-options',
    query: scope == 'team' ? {'scope': 'team'} : null,
  );
  return (
    branches: (res.data!['branches'] as List).cast<String>(),
    buckets: (res.data!['buckets'] as List).cast<String>(),
  );
});

/// Phase 9 (§7.2): single-account lookup lives on `AccountRepository`
/// (cache-fallback + cache-key logic consolidated there). `customerByIdProvider`
/// stays as a thin re-export of that so every existing consumer
/// (CustomerDetailScreen, PTP/Log-Visit screens) keeps watching the same
/// provider name unchanged. The unpaged list counterpart (`worklistProvider`)
/// was removed in Phase 11, once its last consumers (the old call-log and
/// payment screens) were deleted -- the Today screen (Phase 10) reads the paginated
/// `todayWorklistProvider` (features/today/today_provider.dart) instead, and
/// nothing else in the app needed the whole unpaged list.
final customerByIdProvider = FutureProvider.family<Customer, String>((ref, id) {
  final repo = ref.watch(accountRepositoryProvider);
  return repo.fetchById(id);
});

/// Falls back to the last cached response on any failure, rather than
/// throwing straight to ErrorState -- without a cache, offline meant
/// reference data (disposition codes) was completely unreachable. Kept
/// local (rather than moved onto AccountRepository) since disposition codes
/// aren't Account data.
Future<List<Map<String, dynamic>>> _fetchWithCacheFallback(
  Ref ref,
  String cacheKey,
  Future<List<Map<String, dynamic>>> Function() fetch,
) async {
  try {
    final list = await fetch();
    await ReadCache.put(cacheKey, list);
    ref.read(worklistIsStaleProvider.notifier).state = false;
    return list;
  } catch (e) {
    final cached = await ReadCache.get(cacheKey);
    if (cached == null) rethrow;
    ref.read(worklistIsStaleProvider.notifier).state = true;
    return (cached as List).cast<Map<String, dynamic>>();
  }
}

final dispositionCodesProvider = FutureProvider((ref) async {
  final api = ref.watch(apiClientProvider);
  final list = await _fetchWithCacheFallback(ref, 'disposition_codes', () async {
    final res = await api.get<Map<String, dynamic>>('/dispositions');
    // Backend responds with { disposition_codes: [...] } (backend/src/routes/dispositions.ts) --
    // this was reading the wrong key and throwing a cast error at runtime,
    // which silently broke the call-log disposition dropdown for every agent.
    return (res.data!['disposition_codes'] as List).cast<Map<String, dynamic>>();
  });
  return list;
});
