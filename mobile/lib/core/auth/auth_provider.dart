import 'package:device_info_plus/device_info_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../api/api_client.dart';

class AuthState {
  final bool isLoggedIn;
  final Map<String, dynamic>? user;
  final List<String> permissions;

  const AuthState({
    required this.isLoggedIn,
    this.user,
    this.permissions = const [],
  });

  List<String> get capabilities =>
      (user?['capabilities'] as List?)?.cast<String>() ?? const [];
}

class AuthNotifier extends StateNotifier<AuthState> {
  final ApiClient _api;

  AuthNotifier(this._api) : super(const AuthState(isLoggedIn: false));

  Future<void> init() async {
    final has = await hasTokens();
    if (!has) return;
    // Optimistically stay "logged in" while we confirm with the server —
    // an offline app restart must not silently sign the agent out.
    state = const AuthState(isLoggedIn: true);
    try {
      final res = await _api.get<Map<String, dynamic>>('/auth/me');
      final data = res.data!;
      state = AuthState(
        isLoggedIn: true,
        user: data['user'] as Map<String, dynamic>?,
        permissions: (data['permissions'] as List?)?.cast<String>() ?? const [],
      );
    } on DioException catch (e) {
      // Only a real auth rejection (expired/invalid session) should log the
      // user out — a network failure should not.
      if (e.response?.statusCode == 401) {
        await clearTokens();
        state = const AuthState(isLoggedIn: false);
      }
    } catch (_) {
      // Unexpected error: keep the cached logged-in state, no user data yet.
    }
  }

  Future<void> login(String phone, String password) async {
    final deviceId = await _getDeviceId();
    final res = await _api.post<Map<String, dynamic>>(
      '/auth/login',
      data: {'phone': phone, 'password': password, 'device_id': deviceId},
    );
    final data = res.data!;
    await saveTokens(
      data['access_token'] as String,
      data['refresh_token'] as String,
    );
    // The login response's user shape doesn't include permissions — fetch
    // /auth/me right after so state is always the same shape post-login vs
    // post-restore.
    final me = await _api.get<Map<String, dynamic>>('/auth/me');
    state = AuthState(
      isLoggedIn: true,
      user: me.data!['user'] as Map<String, dynamic>?,
      permissions:
          (me.data!['permissions'] as List?)?.cast<String>() ?? const [],
    );
  }

  Future<void> logout() async {
    await clearTokens();
    state = const AuthState(isLoggedIn: false);
  }

  Future<String> _getDeviceId() async {
    final info = DeviceInfoPlugin();
    final android = await info.androidInfo;
    return android.id;
  }

  // Role checks against the capabilities list (backend/src/types/user.ts
  // publicUser() returns capabilities: string[], not per-role booleans).
  bool get isTelecaller => state.capabilities.contains('telecaller');
  bool get isFieldAgent => state.capabilities.contains('field_agent');
}

// Explicit type: see the matching note on apiClientProvider in
// api_client.dart -- the two files import each other, which needs an
// explicit annotation on at least one side to break the type-inference cycle.
final StateNotifierProvider<AuthNotifier, AuthState> authProvider = StateNotifierProvider<AuthNotifier, AuthState>(
  (ref) => AuthNotifier(ref.watch(apiClientProvider)),
);
