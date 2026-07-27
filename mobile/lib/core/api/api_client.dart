import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../auth/auth_provider.dart';

// --dart-define=API_URL=... always wins over the build-mode default below,
// but is itself overridden at runtime by a saved server-URL override (see
// loadServerUrlOverride). 10.0.2.2 = Android emulator -> host loopback.
const _envUrl = String.fromEnvironment('API_URL', defaultValue: '');
const _debugDefaultUrl = 'http://10.0.2.2:4000';
const _releaseDefaultUrl =
    'https://rudrayani-backend-production.up.railway.app';

final _storage = FlutterSecureStorage(
  aOptions: const AndroidOptions(encryptedSharedPreferences: true),
);

// Keys used in secure storage
const _kAccessToken = 'access_token';
const _kRefreshToken = 'refresh_token';
const _kServerUrlOverride = 'server_url_override';

// Cached synchronously so a Dio instance can read it without an async gap —
// buildDio() itself must stay synchronous (it's also called from the field
// initializer of the background tracking isolate's task handler).
String? _cachedOverride;

String get effectiveBaseUrl {
  if (_cachedOverride != null && _cachedOverride!.isNotEmpty) {
    return _cachedOverride!;
  }
  if (_envUrl.isNotEmpty) return _envUrl;
  return kReleaseMode ? _releaseDefaultUrl : _debugDefaultUrl;
}

/// Must be awaited once per isolate before the first buildDio() call (see
/// main.dart and tracking_task.dart) — buildDio() itself stays synchronous.
Future<void> loadServerUrlOverride() async {
  _cachedOverride = await _storage.read(key: _kServerUrlOverride);
}

Future<void> setServerUrlOverride(String? url) async {
  if (url == null || url.isEmpty) {
    await _storage.delete(key: _kServerUrlOverride);
    _cachedOverride = null;
  } else {
    await _storage.write(key: _kServerUrlOverride, value: url);
    _cachedOverride = url;
  }
}

class ApiClient {
  final Dio _dio;

  ApiClient(this._dio);

  Future<Response<T>> get<T>(String path, {Map<String, dynamic>? query}) =>
      _dio.get<T>(path, queryParameters: query);

  Future<Response<T>> post<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? query,
  }) => _dio.post<T>(path, data: data, queryParameters: query);

  Future<Response<T>> patch<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? query,
  }) => _dio.patch<T>(path, data: data, queryParameters: query);

  Future<Response<T>> postForm<T>(String path, FormData data) =>
      _dio.post<T>(path, data: data);
}

/// One in-flight refresh at a time, shared by every concurrent 401. Without
/// this, home_shell.dart's IndexedStack firing 6-8 parallel requests at
/// login could trigger several concurrent refreshes racing against a
/// single-use refresh token -- and since a reused refresh token is now
/// treated as a compromise signal server-side (revokes every session for
/// the user), an unmutexed refresh could log the agent out mid-shift from
/// nothing more than opening the app.
Future<String>? _refreshInFlight;

Future<String> _refresh(String refreshToken) {
  return _refreshInFlight ??= () async {
    try {
      final refreshDio = Dio(BaseOptions(baseUrl: '$effectiveBaseUrl/api'));
      final res = await refreshDio.post(
        '/auth/refresh',
        data: {'refresh_token': refreshToken},
      );
      final newAccess = res.data['access_token'] as String;
      final newRefresh = res.data['refresh_token'] as String?;
      await _storage.write(key: _kAccessToken, value: newAccess);
      if (newRefresh != null) {
        await _storage.write(key: _kRefreshToken, value: newRefresh);
      }
      return newAccess;
    } finally {
      _refreshInFlight = null;
    }
  }();
}

/// Also used by the background tracking isolate (tracking_task.dart), which
/// can't reach Riverpod providers -- [onSessionExpired] is omitted there
/// (nothing to notify) and only wired up by apiClientProvider below.
Dio buildDio({void Function()? onSessionExpired}) {
  final dio = Dio(
    BaseOptions(
      baseUrl: '$effectiveBaseUrl/api',
      // 10s was too aggressive on 2G, where a slow-starting connection
      // could still complete given more time; multipart photo/signature
      // uploads had no sendTimeout at all, so a stalled upload just hung.
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
      sendTimeout: const Duration(seconds: 60),
    ),
  );

  // Attach access token to every request
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) async {
        final token = await _storage.read(key: _kAccessToken);
        if (token != null) options.headers['Authorization'] = 'Bearer $token';
        handler.next(options);
      },
      onError: (error, handler) async {
        // 401 → try refreshing once
        if (error.response?.statusCode == 401) {
          final refreshToken = await _storage.read(key: _kRefreshToken);
          if (refreshToken != null) {
            try {
              final newAccess = await _refresh(refreshToken);
              // Retry original request
              final opts = error.requestOptions;
              opts.headers['Authorization'] = 'Bearer $newAccess';
              final retried = await dio.fetch(opts);
              return handler.resolve(retried);
            } catch (_) {
              await clearTokens();
              // Previously this cleared storage without telling anyone --
              // authProvider's in-memory state stayed "logged in", so the
              // agent kept tapping into 401s on a session that was already
              // dead, with no path back to the login screen.
              onSessionExpired?.call();
            }
          }
        }
        handler.next(error);
      },
    ),
  );

  return dio;
}

// Explicit type on both sides: apiClientProvider's closure reads
// authProvider (for the session-expiry callback) while authProvider's own
// constructor reads apiClientProvider -- the two files import each other,
// and without an explicit annotation here Dart's top-level type inference
// can't resolve the cycle.
final Provider<ApiClient> apiClientProvider = Provider<ApiClient>((ref) {
  // A plain closure, evaluated lazily on the first actual session-expiry
  // event -- never at provider construction time, so this doesn't create a
  // circular *construction* dependency with authProvider (which itself
  // reads apiClientProvider) even though the two files import each other.
  return ApiClient(
    buildDio(onSessionExpired: () => ref.read(authProvider.notifier).logout()),
  );
});

Future<void> saveTokens(String access, String refresh) async {
  await Future.wait([
    _storage.write(key: _kAccessToken, value: access),
    _storage.write(key: _kRefreshToken, value: refresh),
  ]);
}

Future<void> clearTokens() async {
  await Future.wait([
    _storage.delete(key: _kAccessToken),
    _storage.delete(key: _kRefreshToken),
  ]);
}

Future<bool> hasTokens() async {
  final token = await _storage.read(key: _kAccessToken);
  return token != null;
}
