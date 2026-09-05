import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/ui/ui.dart';
import '../../core/utils/friendly_error.dart';

/// Same 8-15 digit range the backend accepts (X6: mobile previously demanded
/// exactly 10). Shared with login_screen.dart's own phone field.
final phoneDigitsRegExp = RegExp(r'^\d{8,15}$');

/// Status check (S2) -- unauthenticated by design (A4: this exists precisely
/// because the user cannot log in), so it goes through `apiClientProvider`'s
/// plain Dio directly, same as login itself.
Future<String?> fetchResetRequestStatus(WidgetRef ref, String phone) async {
  try {
    final res = await ref
        .read(apiClientProvider)
        .get<Map<String, dynamic>>('/auth/password-reset-request', query: {'phone': phone});
    return res.data?['status'] as String?;
  } catch (_) {
    return null;
  }
}

/// Mobile password recovery (A4): a free-text request to an admin/manager,
/// not a self-service reset -- there's no SMS gateway (A2). Deliberately
/// gives an identical response regardless of whether the phone exists
/// server-side, so this screen can never be used to enumerate accounts.
class PasswordResetRequestScreen extends ConsumerStatefulWidget {
  const PasswordResetRequestScreen({super.key});

  @override
  ConsumerState<PasswordResetRequestScreen> createState() => _PasswordResetRequestScreenState();
}

class _PasswordResetRequestScreenState extends ConsumerState<PasswordResetRequestScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _messageCtrl = TextEditingController();
  bool _loading = false;
  bool _submitted = false;
  String? _status;
  String? _error;

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _messageCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).post(
        '/auth/password-reset-request',
        data: {'phone': _phoneCtrl.text.trim(), 'message': _messageCtrl.text.trim()},
      );
      final status = await fetchResetRequestStatus(ref, _phoneCtrl.text.trim());
      if (mounted) setState(() { _submitted = true; _status = status ?? 'pending'; });
    } on DioException catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _statusLine(String status) => switch (status) {
        'pending' => 'Request sent — waiting on your manager.',
        'resolved' => 'Your manager has reset your password — try logging in.',
        'rejected' => 'Your request was not approved. Contact your manager directly.',
        _ => 'Request sent.',
      };

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: 'Forgot Password',
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Enter your phone number and a short note. Your branch manager (or agency admin) '
              'will reset your password and let you know.',
              style: TextStyle(color: AppColors.textSecondary),
            ),
            const SizedBox(height: AppSpacing.lg),
            if (_submitted) ...[
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: AppColors.successContainer,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                ),
                child: Text(_statusLine(_status ?? 'pending'), style: const TextStyle(color: AppColors.successStrong)),
              ),
              const SizedBox(height: AppSpacing.lg),
              AppSecondaryButton(label: 'Back to Sign In', onPressed: () => context.go('/login')),
            ] else
              Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    AppFormField(
                      label: 'Phone Number',
                      controller: _phoneCtrl,
                      keyboardType: TextInputType.phone,
                      prefixIcon: const Icon(Icons.phone),
                      validator: (v) {
                        final value = v?.trim() ?? '';
                        if (value.isEmpty) return 'Required';
                        if (!phoneDigitsRegExp.hasMatch(value)) return 'Enter a valid phone number';
                        return null;
                      },
                    ),
                    const SizedBox(height: AppSpacing.md),
                    AppFormField(
                      label: 'Message',
                      hint: 'e.g. "Forgot my password, please reset it"',
                      controller: _messageCtrl,
                      maxLines: 3,
                      validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : null,
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: AppSpacing.md),
                      Text(_error!, style: const TextStyle(color: AppColors.error)),
                    ],
                    const SizedBox(height: AppSpacing.lg),
                    AppPrimaryButton(label: 'Send Request', loading: _loading, onPressed: _loading ? null : _submit),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
