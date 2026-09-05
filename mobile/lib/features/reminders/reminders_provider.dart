import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_client.dart';
import '../../core/offline/offline_queue.dart';

/// Reminders due today (pending), IST day window handled server-side.
final remindersTodayProvider = FutureProvider<List<Map<String, dynamic>>>((
  ref,
) async {
  final api = ref.watch(apiClientProvider);
  final today = DateTime.now().toIso8601String().substring(0, 10);
  final res = await api.get<Map<String, dynamic>>(
    '/reminders',
    query: {'date': today, 'status': 'pending'},
  );
  return (res.data!['reminders'] as List).cast<Map<String, dynamic>>();
});

/// PTPs due today or overdue — the pre-existing promise-to-pay "reminder"
/// mechanism (brief §6), shown alongside manual reminders in the Today
/// section so an agent has one place to see everything due.
final ptpsDueTodayProvider = FutureProvider<List<Map<String, dynamic>>>((
  ref,
) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get<Map<String, dynamic>>('/ptps/due');
  return (res.data!['ptps'] as List).cast<Map<String, dynamic>>();
});

class RemindersController {
  final Ref ref;
  RemindersController(this.ref);

  /// Creates a reminder. Online: posts immediately. Offline: queues the
  /// create, synced later via the offline queue. Phase 13 (P9): no device
  /// notification is scheduled either way any more -- P9 rules out push
  /// notifications everywhere; a pending reminder surfaces instead in
  /// TodaySection (features/reminders/today_section.dart), already visible
  /// the moment the agent opens the app.
  Future<void> create({
    String? customerId,
    required DateTime remindAt,
    String? note,
  }) async {
    final clientKey = OfflineQueueNotifier.newClientKey();
    final api = ref.read(apiClientProvider);
    final payload = <String, dynamic>{
      'remind_at': remindAt.toUtc().toIso8601String(),
      if (note != null && note.isNotEmpty) 'note': note,
      'client_key': clientKey,
    };
    if (customerId != null) {
      payload['customer_id'] = customerId;
    }

    try {
      await api.post<Map<String, dynamic>>('/reminders', data: payload);
    } catch (e) {
      if (!isOfflineError(e)) rethrow;
      await ref
          .read(offlineQueueProvider.notifier)
          .enqueue(
            QueuedAction(
              clientKey: clientKey,
              type: 'reminder',
              payload: payload,
              createdAt: DateTime.now(),
            ),
          );
    }

    ref.invalidate(remindersTodayProvider);
  }

  Future<void> markDone(String reminderId) async {
    await ref
        .read(apiClientProvider)
        .patch('/reminders/$reminderId', data: {'status': 'done'});
    ref.invalidate(remindersTodayProvider);
  }
}

final remindersControllerProvider = Provider((ref) => RemindersController(ref));
