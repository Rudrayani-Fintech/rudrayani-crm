import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_client.dart';
import '../../core/models/customer.dart';
import '../../core/offline/read_cache.dart';

/// Personal (own allocations) vs Team (every allocation in the branch a
/// branch_manager manages) -- the web equivalent is MyWorklistPage.tsx's
/// Segmented control. Only a branch_manager gets a toggle for this in the
/// UI (see WorklistScreen); everyone else always resolves to personal scope
/// server-side regardless of what this holds.
final worklistScopeProvider = StateProvider<String>((ref) => 'personal');

/// Whether the data currently shown by worklistProvider/customerByIdProvider
/// came from the offline cache rather than a fresh network response --
/// worklist_screen.dart uses this to show "offline — showing cached data"
/// instead of presenting a stale list as live.
final worklistIsStaleProvider = StateProvider<bool>((ref) => false);

/// Falls back to the last cached response on any failure, rather than
/// throwing straight to ErrorState -- without a cache, offline meant the
/// worklist (and everything downstream of it: call logs, payments, PTPs)
/// was completely unreachable, even though the offline queue exists
/// specifically to let those actions be recorded without connectivity.
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

final worklistProvider = FutureProvider<List<Customer>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final scope = ref.watch(worklistScopeProvider);
  final list = await _fetchWithCacheFallback(ref, 'worklist_$scope', () async {
    final res = await api.get<Map<String, dynamic>>(
      '/worklist',
      query: scope == 'team' ? {'scope': 'team'} : null,
    );
    return (res.data!['customers'] as List).cast<Map<String, dynamic>>();
  });
  return list.map(Customer.fromJson).toList();
});

/// Resolves a single assigned customer by id — backs the detail screen and
/// its children (call log / payment / PTPs / field visit), which navigate
/// by id rather than carrying the Customer object across routes (go_router's
/// `extra` doesn't survive an app restart or a cold deep link).
final customerByIdProvider =
    FutureProvider.family<Customer, String>((ref, id) async {
  final api = ref.watch(apiClientProvider);
  final cacheKey = 'customer_$id';
  try {
    final res = await api.get<Map<String, dynamic>>('/worklist/$id');
    final json = res.data!['customer'] as Map<String, dynamic>;
    await ReadCache.put(cacheKey, json);
    return Customer.fromJson(json);
  } catch (e) {
    final cached = await ReadCache.get(cacheKey);
    if (cached == null) rethrow;
    return Customer.fromJson((cached as Map).cast<String, dynamic>());
  }
});

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
