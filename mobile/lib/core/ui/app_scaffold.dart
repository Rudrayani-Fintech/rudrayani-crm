import 'package:flutter/material.dart';

/// Standard screen shell -- replaces per-screen `Scaffold` + `AppBar`
/// duplication. `AppBar` styling itself comes from the app's `AppBarTheme`;
/// this widget just standardizes the title/actions/body/bottom wiring so
/// every screen assembles the same way.
class AppScaffold extends StatelessWidget {
  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? floatingActionButton;
  final Widget? bottomNavigationBar;
  final Widget? bottom;
  final bool resizeToAvoidBottomInset;

  const AppScaffold({
    super.key,
    required this.title,
    required this.body,
    this.actions,
    this.floatingActionButton,
    this.bottomNavigationBar,
    this.bottom,
    this.resizeToAvoidBottomInset = true,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      resizeToAvoidBottomInset: resizeToAvoidBottomInset,
      appBar: AppBar(
        title: Text(title),
        actions: actions,
        bottom: bottom == null
            ? null
            : PreferredSize(
                preferredSize: const Size.fromHeight(kToolbarHeight),
                child: bottom!,
              ),
      ),
      body: body,
      floatingActionButton: floatingActionButton,
      bottomNavigationBar: bottomNavigationBar,
    );
  }
}
