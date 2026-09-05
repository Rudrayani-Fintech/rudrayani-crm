import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Live "no network" state for the duty bar's offline alert (F6: "add an
/// explicit offline-mode alert"). Distinct from [worklistIsStaleProvider]
/// (account_repository.dart), which only flips after a fetch has actually
/// failed and fallen back to cache -- this reflects the OS-reported
/// connectivity state directly, so the alert appears the moment the network
/// drops rather than waiting for the next failed request.
final isOfflineProvider = StreamProvider<bool>((ref) async* {
  final initial = await Connectivity().checkConnectivity();
  yield !initial.any((r) => r != ConnectivityResult.none);
  yield* Connectivity().onConnectivityChanged.map(
        (results) => !results.any((r) => r != ConnectivityResult.none),
      );
});
