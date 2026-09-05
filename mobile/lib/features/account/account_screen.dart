import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/app_theme.dart';
import '../../core/tracking/tracking_service.dart';
import '../../core/ui/ui.dart';

/// `GET /branches` is deliberately open to any authenticated user (see its
/// own comment in branches.ts -- every role needs the full list for
/// pickers), so resolving the signed-in user's own `branch_id` to a
/// readable name doesn't need a new endpoint or a wider permission.
final _branchNameProvider = FutureProvider.autoDispose<String?>((ref) async {
  final branchId = ref.read(authProvider).user?['branch_id'] as String?;
  if (branchId == null) return null;
  final api = ref.read(apiClientProvider);
  final res = await api.get<Map<String, dynamic>>('/branches');
  final branches = (res.data!['branches'] as List).cast<Map<String, dynamic>>();
  for (final b in branches) {
    if (b['id'] == branchId) return b['name'] as String?;
  }
  return null;
});

/// Phase 13 (S6): Account keeps name, phone, branch, and Log out -- nothing
/// else. The six admin lists, the Punch Out card (now the duty bar's job,
/// reachable from every tab since Phase 10), and every management/admin
/// section are gone.
class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  Future<void> _confirmLogout(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Log out?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Log out')),
        ],
      ),
    );
    if (ok == true) {
      // Shift stays open server-side, but the service must not outlive the
      // session's tokens -- punch out properly to close the shift.
      await TrackingService.stop();
      await ref.read(authProvider.notifier).logout();
      // ignore: use_build_context_synchronously
      if (context.mounted) context.go('/login');
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authProvider).user;
    final branchName = ref.watch(_branchNameProvider);

    return AppScaffold(
      title: 'Account',
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 32,
                backgroundColor: AppColors.primary,
                child: Text(
                  ((user?['full_name'] as String?)?.isNotEmpty == true ? user!['full_name'] as String : 'U')[0]
                      .toUpperCase(),
                  style: const TextStyle(fontSize: 24, color: AppColors.onPrimary),
                ),
              ),
              const SizedBox(width: AppSpacing.lg),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      user?['full_name'] as String? ?? 'Agent',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xl),
          AppListRow(
            leading: const Icon(Icons.phone_outlined, color: AppColors.textSecondary),
            title: const Text('Phone'),
            subtitle: Text(user?['phone'] as String? ?? '—'),
          ),
          AppListRow(
            leading: const Icon(Icons.apartment_outlined, color: AppColors.textSecondary),
            title: const Text('Branch'),
            subtitle: branchName.when(
              data: (name) => Text(name ?? '—'),
              loading: () => const Text('Loading…'),
              error: (_, _) => const Text('—'),
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
          AppSecondaryButton(
            icon: Icons.logout,
            label: 'Log out',
            onPressed: () => _confirmLogout(context, ref),
          ),
        ],
      ),
    );
  }
}
