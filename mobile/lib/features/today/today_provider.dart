import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/data/account_repository.dart';
import '../../core/models/account.dart';
import '../../core/offline/worklist_filter_store.dart';
import '../worklist/worklist_provider.dart';

/// Search box text for the Today worklist (P6: search, not sort). Debounced
/// in the UI layer (TodayScreen), same 300ms pattern the old WorklistScreen
/// used for its client-side filter -- server-side now (§4.1), so a shorter
/// debounce would just mean more redundant network requests while typing.
final todaySearchQueryProvider = StateProvider.autoDispose<String>((ref) => '');

/// Where a customer sorts once worked-state is the primary key (§4.1: `ORDER
/// BY (worked_today) ASC, ...`) -- pushes a row this session just marked
/// worked to the bottom locally, without waiting for the next fetch to
/// reflect it. Extracted as a pure function so the resort behaviour has a
/// fast, dependency-free unit test (see test/today_provider_test.dart).
List<Account> sortWithWorkedSunk(List<Account> items) {
  final sorted = [...items];
  sorted.sort((a, b) {
    final aWorked = a.workedToday == true;
    final bWorked = b.workedToday == true;
    if (aWorked != bWorked) return aWorked ? 1 : -1;
    return 0; // stable sort keeps the server's own ordering within each group
  });
  return sorted;
}

class TodayWorklistState {
  final List<Account> items;
  final int total;
  final bool loading;
  final bool loadingMore;
  final bool hasMore;
  final Object? error;

  const TodayWorklistState({
    this.items = const [],
    this.total = 0,
    this.loading = true,
    this.loadingMore = false,
    this.hasMore = true,
    this.error,
  });

  TodayWorklistState copyWith({
    List<Account>? items,
    int? total,
    bool? loading,
    bool? loadingMore,
    bool? hasMore,
    Object? error,
  }) =>
      TodayWorklistState(
        items: items ?? this.items,
        total: total ?? this.total,
        loading: loading ?? this.loading,
        loadingMore: loadingMore ?? this.loadingMore,
        hasMore: hasMore ?? this.hasMore,
        error: error,
      );
}

/// Lazy-paginated worklist (§4.1, N5, P7, S8: 50 rows/page, infinite scroll,
/// server-side search+filter) backing the Today screen. One page owner per
/// scope+filter+search combination -- Riverpod recreates this whole notifier
/// (dropping loaded pages) whenever `worklistScopeProvider`/
/// `worklistFiltersProvider`/`todaySearchQueryProvider` change, which is the
/// correct behaviour: those are different queries, not different pages of
/// the same one.
class TodayWorklistNotifier extends StateNotifier<TodayWorklistState> {
  final Ref ref;
  final String scope;
  final WorklistFilterSelection filters;
  final String query;
  static const _pageSize = 50;
  int _page = 1;

  TodayWorklistNotifier(this.ref, {required this.scope, required this.filters, required this.query})
      : super(const TodayWorklistState()) {
    _loadFirstPage();
  }

  AccountRepository get _repo => ref.read(accountRepositoryProvider);

  Future<void> _loadFirstPage() async {
    state = state.copyWith(loading: true, error: null);
    try {
      final page = await _repo.fetchWorklistPage(
        scope: scope,
        filters: filters,
        page: 1,
        limit: _pageSize,
        q: query,
      );
      _page = 1;
      state = TodayWorklistState(
        items: sortWithWorkedSunk(page.items),
        total: page.total,
        loading: false,
        hasMore: page.items.length < page.total,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: e);
    }
  }

  Future<void> refresh() => _loadFirstPage();

  Future<void> loadMore() async {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    state = state.copyWith(loadingMore: true);
    try {
      final next = _page + 1;
      final page = await _repo.fetchWorklistPage(
        scope: scope,
        filters: filters,
        page: next,
        limit: _pageSize,
        q: query,
      );
      _page = next;
      final merged = sortWithWorkedSunk([...state.items, ...page.items]);
      state = state.copyWith(
        items: merged,
        loadingMore: false,
        hasMore: merged.length < page.total,
      );
    } catch (e) {
      // A failed "load more" leaves the already-loaded rows on screen --
      // only the initial load surfaces a blocking error state.
      state = state.copyWith(loadingMore: false);
    }
  }

  /// Phase 10 acceptance: "Logging a visit greys the row and sinks it
  /// without a full reload." Called by the Log Visit screen after a
  /// successful save -- updates the in-memory row directly rather than
  /// re-fetching the list over the network.
  void markWorked(String customerId, {double? collectedDelta}) {
    final idx = state.items.indexWhere((a) => a.id == customerId);
    if (idx == -1) return;
    final current = state.items[idx];
    final updated = current.copyWith(
      workedToday: true,
      collectedToday: (current.collectedToday ?? 0) + (collectedDelta ?? 0),
    );
    final next = [...state.items]..[idx] = updated;
    state = state.copyWith(items: sortWithWorkedSunk(next));
  }
}

final todayWorklistProvider =
    StateNotifierProvider.autoDispose<TodayWorklistNotifier, TodayWorklistState>((ref) {
  final scope = ref.watch(worklistScopeProvider);
  final filters = ref.watch(worklistFiltersProvider);
  final query = ref.watch(todaySearchQueryProvider);
  return TodayWorklistNotifier(ref, scope: scope, filters: filters, query: query);
});
