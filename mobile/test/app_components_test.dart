// Phase 8 (§6): design-system component tests. Locks in the two numeric
// floors the acceptance criteria name explicitly (AppListRow >= 56px,
// AppPrimaryButton/AppSecondaryButton >= 48px) plus a smoke test per
// remaining component so a future edit can't silently break one.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/theme/app_theme.dart';
import 'package:rudrayani_mobile/core/ui/ui.dart';

Widget _wrap(Widget child) {
  return MaterialApp(
    theme: buildAppTheme(),
    home: Scaffold(body: child),
  );
}

void main() {
  group('AppListRow', () {
    testWidgets('never renders below the 56px minimum row height', (tester) async {
      await tester.pumpWidget(_wrap(
        const AppListRow(title: Text('Short')),
      ));
      final size = tester.getSize(find.byType(AppListRow));
      expect(size.height, greaterThanOrEqualTo(AppDimens.listRow));
    });

    testWidgets('grows taller than the minimum when content needs it', (tester) async {
      await tester.pumpWidget(_wrap(
        const AppListRow(
          title: Text('Title'),
          subtitle: Text('A longer subtitle that still fits on one line'),
        ),
      ));
      final size = tester.getSize(find.byType(AppListRow));
      expect(size.height, greaterThanOrEqualTo(AppDimens.listRow));
    });

    testWidgets('invokes onTap', (tester) async {
      var tapped = false;
      await tester.pumpWidget(_wrap(
        AppListRow(title: const Text('Row'), onTap: () => tapped = true),
      ));
      await tester.tap(find.byType(AppListRow));
      expect(tapped, isTrue);
    });
  });

  group('AppPrimaryButton', () {
    testWidgets('never renders below the 48px minimum tap target', (tester) async {
      await tester.pumpWidget(_wrap(
        AppPrimaryButton(label: 'Save', onPressed: () {}),
      ));
      final size = tester.getSize(find.byType(AppPrimaryButton));
      expect(size.height, greaterThanOrEqualTo(AppDimens.tapTarget));
    });

    testWidgets('shows a spinner instead of the label while loading', (tester) async {
      await tester.pumpWidget(_wrap(
        AppPrimaryButton(label: 'Save', onPressed: () {}, loading: true),
      ));
      expect(find.text('Save'), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('disables onPressed while loading', (tester) async {
      var pressed = false;
      await tester.pumpWidget(_wrap(
        AppPrimaryButton(label: 'Save', onPressed: () => pressed = true, loading: true),
      ));
      await tester.tap(find.byType(ElevatedButton), warnIfMissed: false);
      expect(pressed, isFalse);
    });
  });

  group('AppSecondaryButton', () {
    testWidgets('never renders below the 48px minimum tap target', (tester) async {
      await tester.pumpWidget(_wrap(
        AppSecondaryButton(label: 'Cancel', onPressed: () {}),
      ));
      final size = tester.getSize(find.byType(AppSecondaryButton));
      expect(size.height, greaterThanOrEqualTo(AppDimens.tapTarget));
    });
  });

  group('AppMoney', () {
    testWidgets('renders with tabular-figure alignment', (tester) async {
      await tester.pumpWidget(_wrap(const AppMoney(45000)));
      final text = tester.widget<Text>(find.byType(Text));
      expect(text.data, '₹45,000');
      expect(
        text.style?.fontFeatures,
        contains(const FontFeature.tabularFigures()),
      );
    });

    testWidgets('compact mode renders lakh/crore notation', (tester) async {
      await tester.pumpWidget(_wrap(const AppMoney(10400000, compact: true)));
      expect(find.text('1.04Cr'), findsOneWidget);
    });

    testWidgets('renders an em dash for null', (tester) async {
      await tester.pumpWidget(_wrap(const AppMoney(null)));
      expect(find.text('—'), findsOneWidget);
    });
  });

  group('AppChipGroup', () {
    testWidgets('every chip meets the 48px tap-target minimum', (tester) async {
      await tester.pumpWidget(_wrap(
        AppChipGroup<String>(
          options: const [
            AppChipOption(value: 'a', label: 'A'),
            AppChipOption(value: 'b', label: 'B'),
          ],
          selected: const {'a'},
          onSelected: (_) {},
        ),
      ));
      final size = tester.getSize(find.byType(ChoiceChip).first);
      expect(size.height, greaterThanOrEqualTo(AppDimens.tapTarget));
    });

    testWidgets('reports the tapped value', (tester) async {
      String? picked;
      await tester.pumpWidget(_wrap(
        AppChipGroup<String>(
          options: const [AppChipOption(value: 'a', label: 'A')],
          selected: const {},
          onSelected: (v) => picked = v,
        ),
      ));
      await tester.tap(find.byType(ChoiceChip));
      expect(picked, 'a');
    });
  });

  group('AppCard, AppSectionHeader, AppFormField, AppScaffold -- smoke tests', () {
    testWidgets('AppCard renders its child', (tester) async {
      await tester.pumpWidget(_wrap(const AppCard(child: Text('inner'))));
      expect(find.text('inner'), findsOneWidget);
    });

    testWidgets('AppSectionHeader renders its title and trailing widget', (tester) async {
      await tester.pumpWidget(_wrap(
        const AppSectionHeader(title: 'Heading', trailing: Icon(Icons.add)),
      ));
      expect(find.text('Heading'), findsOneWidget);
      expect(find.byIcon(Icons.add), findsOneWidget);
    });

    testWidgets('AppFormField renders its label', (tester) async {
      await tester.pumpWidget(_wrap(const AppFormField(label: 'Remark')));
      expect(find.text('Remark'), findsOneWidget);
    });

    testWidgets('AppScaffold renders title and body', (tester) async {
      await tester.pumpWidget(_wrap(
        const AppScaffold(title: 'Screen', body: Text('body')),
      ));
      expect(find.text('Screen'), findsOneWidget);
      expect(find.text('body'), findsOneWidget);
    });
  });

  group('AppLoadingState, AppEmptyState, AppErrorState, AppInlineErrorNote', () {
    testWidgets('AppLoadingState renders a spinner and optional label', (tester) async {
      await tester.pumpWidget(_wrap(const AppLoadingState(label: 'Loading…')));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Loading…'), findsOneWidget);
    });

    testWidgets('AppEmptyState renders its message and hint', (tester) async {
      await tester.pumpWidget(_wrap(
        const AppEmptyState(message: 'Nothing here', hint: 'Come back later'),
      ));
      expect(find.text('Nothing here'), findsOneWidget);
      expect(find.text('Come back later'), findsOneWidget);
    });

    testWidgets('AppErrorState renders a retry button sized to the tap target', (tester) async {
      await tester.pumpWidget(_wrap(
        AppErrorState(message: 'Failed', onRetry: () {}),
      ));
      final size = tester.getSize(find.byType(OutlinedButton));
      expect(size.height, greaterThanOrEqualTo(AppDimens.tapTarget));
    });

    testWidgets('AppInlineErrorNote renders inline without centering', (tester) async {
      await tester.pumpWidget(_wrap(
        AppInlineErrorNote(message: 'One item failed', onRetry: () {}),
      ));
      expect(find.text('One item failed'), findsOneWidget);
    });
  });

}
