import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../offline/offline_queue.dart';
import '../theme/app_theme.dart';

const Map<String, String> _typeLabels = {
  'call_log': 'Call log',
  'payment': 'Payment',
  'field_visit': 'Field visit',
  'reminder': 'Reminder',
  'attachment': 'Document',
};

/// Offline-queue state: how many actions are waiting to sync, and the last
/// permanent rejection if the server refused one (brief §8 offline mode).
///
/// Previously mounted only inside WorklistScreen, so an agent on any other
/// tab (customer detail, dashboards, account) had no idea payments were
/// sitting unsynced. Lives in the app shell now so it's visible everywhere,
/// and is tappable through to a list of exactly what's pending.
class SyncBanner extends ConsumerWidget {
  const SyncBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = ref.watch(offlineQueueProvider);
    if (q.pending == 0 && q.lastError == null) return const SizedBox.shrink();

    return InkWell(
      onTap: () => _showPendingSheet(context, ref),
      child: Container(
        width: double.infinity,
        color: q.lastError != null ? AppColors.errorContainer : AppColors.warningContainer,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Row(
          children: [
            Icon(
              q.lastError != null ? Icons.error_outline : Icons.cloud_upload_outlined,
              size: 16,
              color: q.lastError != null ? AppColors.errorStrong : AppColors.warningStrong,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                q.lastError ??
                    (q.syncing
                        ? 'Syncing ${q.pending} offline action(s)…'
                        : '${q.pending} action(s) waiting to sync — tap to view'),
                style: TextStyle(
                  fontSize: 12,
                  color: q.lastError != null ? AppColors.errorStrong : AppColors.warningStrong,
                ),
              ),
            ),
            if (q.lastError != null)
              TextButton(
                onPressed: () => ref.read(offlineQueueProvider.notifier).clearError(),
                child: const Text('Dismiss', style: TextStyle(fontSize: 12)),
              )
            else if (!q.syncing)
              TextButton(
                onPressed: () => ref.read(offlineQueueProvider.notifier).flush(),
                child: const Text('Sync now', style: TextStyle(fontSize: 12)),
              ),
          ],
        ),
      ),
    );
  }

  void _showPendingSheet(BuildContext context, WidgetRef ref) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _PendingSyncSheet(),
    );
  }
}

class _PendingSyncSheet extends ConsumerWidget {
  const _PendingSyncSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = ref.watch(offlineQueueProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Pending sync (${q.items.length})',
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.5),
              child: q.items.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 16),
                      child: Text('Nothing pending — everything is synced.'),
                    )
                  : ListView.separated(
                      shrinkWrap: true,
                      itemCount: q.items.length,
                      separatorBuilder: (context, i) => const Divider(height: 1),
                      itemBuilder: (ctx, i) {
                        final item = q.items[i];
                        return ListTile(
                          leading: Icon(
                            item.deadLetter ? Icons.error_outline : Icons.schedule,
                            color: item.deadLetter ? AppColors.error : AppColors.warning,
                          ),
                          title: Text(_typeLabels[item.type] ?? item.type),
                          subtitle: Text(
                            '${DateFormat('dd MMM, HH:mm').format(item.createdAt.toLocal())}'
                            '${item.deadLetter ? ' · failed after ${item.retryCount} attempts' : item.retryCount > 0 ? ' · retried ${item.retryCount}x' : ''}',
                            style: const TextStyle(fontSize: 12),
                          ),
                          trailing: item.deadLetter
                              ? TextButton(
                                  onPressed: () => ref.read(offlineQueueProvider.notifier).discard(item.clientKey),
                                  child: const Text('Discard'),
                                )
                              : null,
                        );
                      },
                    ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: AppDimens.tapTarget,
              width: double.infinity,
              child: OutlinedButton(
                onPressed: q.syncing ? null : () => ref.read(offlineQueueProvider.notifier).flush(),
                child: Text(q.syncing ? 'Syncing…' : 'Sync now'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
