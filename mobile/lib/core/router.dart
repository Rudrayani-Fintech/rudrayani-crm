import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../core/auth/auth_provider.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/password_reset_request_screen.dart';
import '../features/home/home_shell.dart';
import '../features/worklist/customer_detail_screen.dart';
import '../features/field_visit/field_visit_screen.dart';
import '../features/ptps/ptps_screen.dart';
import '../core/tracking/attendance_provider.dart';
import '../features/attendance/punch_in_screen.dart';
import 'ui/component_gallery_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  // Phase 9 (§7.6): split apart -- previously one function watched both
  // authProvider and attendanceProvider in full and re-derived a coupled
  // auth+punch-in decision on every navigation, rebuilding this whole
  // GoRouter (a new router instance) on any change to either provider's
  // state, not just the two booleans that actually matter here. `.select`
  // narrows that to just `isLoggedIn`/`punchedIn`, and each gate route
  // (/login, /punch-in, /home) now owns its own small `redirect` -- auth is
  // still checked for every route (a router-level concern), but punch-in is
  // now a guard local to the routes that need it, not a global check
  // re-run for every unrelated navigation (e.g. /customer/*).
  final loggedIn = ref.watch(authProvider.select((s) => s.isLoggedIn));
  final punchedIn = ref.watch(attendanceProvider.select((s) => s.punchedIn));

  return GoRouter(
    initialLocation: loggedIn ? (punchedIn ? '/home' : '/punch-in') : '/login',
    redirect: (_, state) {
      // Phase 8 (§6): the component gallery is a dev-only visual-review tool,
      // reachable regardless of auth/punch-in state.
      if (state.matchedLocation == '/dev/gallery') return null;
      // Phase 13 (A4): a locked-out user reaches this screen precisely
      // because they cannot log in, so it must not require being logged in.
      if (state.matchedLocation == '/password-reset-request') return null;
      if (!loggedIn && state.matchedLocation != '/login') return '/login';
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        redirect: (_, _) => loggedIn ? (punchedIn ? '/home' : '/punch-in') : null,
        builder: (ctx, s) => const LoginScreen(),
      ),
      GoRoute(
        path: '/password-reset-request',
        builder: (ctx, s) => const PasswordResetRequestScreen(),
      ),
      GoRoute(path: '/dev/gallery', builder: (ctx, s) => const ComponentGalleryScreen()),
      GoRoute(
        path: '/punch-in',
        redirect: (_, _) => punchedIn ? '/home' : null,
        builder: (ctx, s) => const PunchInScreen(),
      ),
      GoRoute(
        path: '/home',
        redirect: (_, _) => punchedIn ? null : '/punch-in',
        builder: (ctx, s) => const HomeShell(),
      ),
      GoRoute(
        path: '/customer/:id',
        builder: (_, state) => CustomerDetailScreen(
          customerId: state.pathParameters['id']!,
        ),
        routes: [
          GoRoute(
            path: 'ptps',
            builder: (_, state) => PtpsScreen(
              customerId: state.pathParameters['id']!,
            ),
          ),
          GoRoute(
            path: 'field-visit',
            builder: (_, state) => FieldVisitScreen(
              customerId: state.pathParameters['id']!,
            ),
          ),
        ],
      ),
    ],
  );
});
