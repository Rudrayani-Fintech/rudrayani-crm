import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/auth/auth_provider.dart';
import 'core/router.dart';
import 'core/theme/app_theme.dart';
import 'core/tracking/tracking_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Port for UI <-> tracking-service isolate communication (must be set up
  // before runApp per flutter_foreground_task docs).
  TrackingService.initCommunicationPort();
  runApp(const ProviderScope(child: RudrayaniApp()));
}

class RudrayaniApp extends ConsumerStatefulWidget {
  const RudrayaniApp({super.key});

  @override
  ConsumerState<RudrayaniApp> createState() => _RudrayaniAppState();
}

class _RudrayaniAppState extends ConsumerState<RudrayaniApp> {
  @override
  void initState() {
    super.initState();
    // Restore session on startup
    Future.microtask(() => ref.read(authProvider.notifier).init());
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);

    return MaterialApp.router(
      title: 'Rudrayani CRM',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      routerConfig: router,
    );
  }
}
