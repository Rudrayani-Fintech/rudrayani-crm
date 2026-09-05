import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/app_theme.dart';
import 'password_reset_request_screen.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  bool _loading = false;
  String? _error;
  // S2: a locked-out agent who already sent a password-reset request sees
  // its status right here, without needing to remember to reopen that
  // screen -- debounced the same way the Today screen's search box is, so
  // typing a phone number doesn't fire a request per keystroke.
  String? _resetStatus;
  Timer? _statusDebounce;

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _passCtrl.dispose();
    _statusDebounce?.cancel();
    super.dispose();
  }

  void _onPhoneChanged(String value) {
    _statusDebounce?.cancel();
    final phone = value.trim();
    if (!phoneDigitsRegExp.hasMatch(phone)) {
      setState(() => _resetStatus = null);
      return;
    }
    _statusDebounce = Timer(const Duration(milliseconds: 500), () async {
      final status = await fetchResetRequestStatus(ref, phone);
      if (mounted && _phoneCtrl.text.trim() == phone) setState(() => _resetStatus = status);
    });
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref
          .read(authProvider.notifier)
          .login(_phoneCtrl.text.trim(), _passCtrl.text);
      if (mounted) context.go('/home');
    } catch (e) {
      String msg = 'Login failed. Check your credentials.';
      if (e is DioException) {
        if (e.response?.statusCode == 401) {
          msg = 'Invalid phone number or password.';
        } else if (e.response?.statusCode == 423) {
          msg = 'Account locked. Contact your manager.';
        } else if (e.type == DioExceptionType.connectionError ||
            e.type == DioExceptionType.connectionTimeout) {
          msg = 'Cannot reach server — check your internet connection.';
        } else if (e.response?.data is Map &&
            (e.response!.data['error'] as String?) != null) {
          msg = e.response!.data['error'] as String;
        }
      }
      setState(() => _error = msg);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _statusLine(String status) => switch (status) {
        'pending' => 'Password reset request sent — waiting on your manager.',
        'resolved' => 'Your manager has reset your password — try signing in.',
        'rejected' => 'Your reset request was not approved.',
        _ => '',
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.primaryDark,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              children: [
                // Logo / branding
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: AppColors.primary,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: const Icon(
                    Icons.account_balance,
                    color: AppColors.onPrimary,
                    size: 48,
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'Rudrayani CRM',
                  style: Theme.of(context).textTheme.headlineSmall
                      ?.copyWith(
                        color: AppColors.onPrimary,
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Collection Management',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: AppColors.onPrimary.withValues(alpha: 0.54),
                  ),
                ),
                const SizedBox(height: 40),
                Card(
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          TextFormField(
                            controller: _phoneCtrl,
                            keyboardType: TextInputType.phone,
                            decoration: const InputDecoration(
                              labelText: 'Phone Number',
                              prefixIcon: Icon(Icons.phone),
                              border: OutlineInputBorder(),
                            ),
                            onChanged: _onPhoneChanged,
                            validator: (v) {
                              final value = v?.trim() ?? '';
                              if (value.isEmpty) return 'Required';
                              // X6: mobile demanded exactly 10 digits; the
                              // backend accepts 8-15 (phoneDigitsRegExp).
                              if (!phoneDigitsRegExp.hasMatch(value)) {
                                return 'Enter a valid phone number';
                              }
                              return null;
                            },
                          ),
                          if (_resetStatus != null) ...[
                            const SizedBox(height: 8),
                            Text(
                              _statusLine(_resetStatus!),
                              style: const TextStyle(color: AppColors.warning, fontSize: 12),
                            ),
                          ],
                          const SizedBox(height: 16),
                          TextFormField(
                            controller: _passCtrl,
                            obscureText: true,
                            decoration: const InputDecoration(
                              labelText: 'Password',
                              prefixIcon: Icon(Icons.lock),
                              border: OutlineInputBorder(),
                            ),
                            validator: (v) => (v == null || v.isEmpty)
                                ? 'Required'
                                : null,
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 12),
                            Text(
                              _error!,
                              style: const TextStyle(color: AppColors.error),
                              textAlign: TextAlign.center,
                            ),
                          ],
                          const SizedBox(height: 24),
                          SizedBox(
                            height: AppDimens.tapTarget,
                            child: ElevatedButton(
                              onPressed: _loading ? null : _submit,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: AppColors.primary,
                                foregroundColor: AppColors.onPrimary,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(8),
                                ),
                              ),
                              child: _loading
                                  ? const SizedBox(
                                      height: 20,
                                      width: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: AppColors.onPrimary,
                                      ),
                                    )
                                  : const Text(
                                      'Sign In',
                                      style: TextStyle(
                                        fontSize: 16,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                            ),
                          ),
                          const SizedBox(height: 12),
                          TextButton(
                            onPressed: () => context.push('/password-reset-request'),
                            child: const Text('Forgot password?'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
