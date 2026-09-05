import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../core/auth/auth_provider.dart';
import '../features/auth/login_screen.dart';
import '../features/home/home_shell.dart';
import '../features/worklist/customer_detail_screen.dart';
import '../features/call_log/call_log_screen.dart';
import '../features/field_visit/field_visit_screen.dart';
import '../features/payment/payment_screen.dart';
import '../features/ptps/ptps_screen.dart';
import '../features/account/views/generic_list_screen.dart';
import '../features/account/views/employee_detail_screen.dart';
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
  // re-run for every unrelated navigation (e.g. /account/* <-> /customer/*).
  final loggedIn = ref.watch(authProvider.select((s) => s.isLoggedIn));
  final punchedIn = ref.watch(attendanceProvider.select((s) => s.punchedIn));

  return GoRouter(
    initialLocation: loggedIn ? (punchedIn ? '/home' : '/punch-in') : '/login',
    redirect: (_, state) {
      // Phase 8 (§6): the component gallery is a dev-only visual-review tool,
      // reachable regardless of auth/punch-in state.
      if (state.matchedLocation == '/dev/gallery') return null;
      if (!loggedIn && state.matchedLocation != '/login') return '/login';
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        redirect: (_, _) => loggedIn ? (punchedIn ? '/home' : '/punch-in') : null,
        builder: (ctx, s) => const LoginScreen(),
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
        path: '/account/customers',
        builder: (ctx, s) => GenericListScreen<Map<String, dynamic>>(
          title: 'All Customers',
          endpoint: '/customers',
          dataKey: 'customers',
          parser: (e) => e,
          builder: (e) => ListTile(
            title: Text(e['customer_name'] ?? 'Unknown'),
            subtitle: Text(e['loan_number'] ?? ''),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => ctx.push('/customer/${e['id']}'),
          ),
        ),
      ),
      GoRoute(
        path: '/account/employees',
        builder: (ctx, s) => GenericListScreen<Map<String, dynamic>>(
          title: 'Employees',
          endpoint: '/employees',
          dataKey: 'employees',
          parser: (e) => e,
          builder: (e) => ListTile(
            title: Text(e['full_name'] ?? 'Unknown'),
            subtitle: Text(e['email'] ?? ''),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => ctx.push('/account/employee/${e['id']}'),
          ),
        ),
      ),
      GoRoute(
        path: '/account/employee/:id',
        builder: (ctx, s) => EmployeeDetailScreen(
          employeeId: s.pathParameters['id']!,
        ),
      ),
      GoRoute(
        path: '/account/ptps/:status',
        builder: (ctx, s) {
          final status = s.pathParameters['status']!;
          return GenericListScreen<Map<String, dynamic>>(
            title: '${status.toUpperCase()} PTPs',
            endpoint: '/ptps?status=$status',
            dataKey: 'ptps',
            parser: (e) => e,
            builder: (e) => ListTile(
              title: Text(e['customer_name'] ?? 'Unknown Customer'),
              subtitle: Text('Amount: ₹${e['amount']} • Date: ${e['promised_date']}'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => ctx.push('/customer/${e['customer_id']}'),
            ),
          );
        },
      ),
      GoRoute(
        path: '/account/teams',
        builder: (ctx, s) => GenericListScreen<Map<String, dynamic>>(
          title: 'Teams',
          endpoint: '/teams',
          dataKey: 'teams',
          parser: (e) => e,
          builder: (e) => ListTile(
            title: Text(e['name'] ?? 'Unknown'),
            subtitle: Text(e['branch_name'] ?? ''),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => ctx.push('/account/team/${e['id']}/members'),
          ),
        ),
      ),
      // Team roster drill-down (branch_manager's "Teams in this Branch" and
      // the generic Teams list both land here) -- reuses GenericListScreen +
      // the existing server-side team_id filter on GET /employees, same as
      // /account/employees above, just pre-filtered to one team.
      GoRoute(
        path: '/account/team/:id/members',
        builder: (ctx, s) {
          final teamId = s.pathParameters['id']!;
          return GenericListScreen<Map<String, dynamic>>(
            title: 'Team Members',
            endpoint: '/employees?team_id=$teamId',
            dataKey: 'employees',
            parser: (e) => e,
            builder: (e) => ListTile(
              title: Text(e['full_name'] ?? 'Unknown'),
              subtitle: Text(e['designation'] ?? ''),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => ctx.push('/account/employee/${e['id']}'),
            ),
          );
        },
      ),
      GoRoute(
        path: '/account/branches',
        builder: (ctx, s) => GenericListScreen<Map<String, dynamic>>(
          title: 'Branches',
          endpoint: '/branches',
          dataKey: 'branches',
          parser: (e) => e,
          builder: (e) => ListTile(
            title: Text(e['name'] ?? 'Unknown'),
          ),
        ),
      ),
      GoRoute(
        path: '/account/companies',
        builder: (ctx, s) => GenericListScreen<Map<String, dynamic>>(
          title: 'Companies',
          endpoint: '/companies',
          dataKey: 'companies',
          parser: (e) => e,
          builder: (e) => ListTile(
            title: Text(e['name'] ?? 'Unknown'),
          ),
        ),
      ),
      GoRoute(
        path: '/account/catalog',
        builder: (ctx, s) => GenericListScreen<Map<String, dynamic>>(
          title: 'Products',
          endpoint: '/products',
          dataKey: 'products',
          parser: (e) => e,
          builder: (e) => ListTile(
            title: Text(e['canonical_label'] ?? e['raw_label'] ?? 'Unknown'),
          ),
        ),
      ),
      GoRoute(
        path: '/customer/:id',
        builder: (_, state) => CustomerDetailScreen(
          customerId: state.pathParameters['id']!,
        ),
        routes: [
          GoRoute(
            path: 'call-log',
            builder: (_, state) => CallLogScreen(
              customerId: state.pathParameters['id']!,
            ),
          ),
          GoRoute(
            path: 'payment',
            builder: (_, state) => PaymentScreen(
              customerId: state.pathParameters['id']!,
            ),
          ),
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
