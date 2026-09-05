// Phase 8 (§6): core/widgets/state_views.dart now just aliases the real
// core/ui/app_state_views.dart implementations, so every screen still using
// the old LoadingState/EmptyState/ErrorState/InlineErrorNote names keeps
// compiling unchanged. This locks in that the alias actually resolves to
// the new widget, not a stale duplicate.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/widgets/state_views.dart';
import 'package:rudrayani_mobile/core/ui/app_state_views.dart' as ui;

void main() {
  testWidgets('LoadingState is the same type as AppLoadingState', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: LoadingState(label: 'x')));
    expect(find.byType(ui.AppLoadingState), findsOneWidget);
  });

  testWidgets('EmptyState is the same type as AppEmptyState', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: EmptyState(message: 'x')));
    expect(find.byType(ui.AppEmptyState), findsOneWidget);
  });

  testWidgets('ErrorState is the same type as AppErrorState', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: ErrorState(message: 'x')));
    expect(find.byType(ui.AppErrorState), findsOneWidget);
  });

  testWidgets('InlineErrorNote is the same type as AppInlineErrorNote', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: InlineErrorNote(message: 'x')));
    expect(find.byType(ui.AppInlineErrorNote), findsOneWidget);
  });
}
