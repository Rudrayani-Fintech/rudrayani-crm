// Phase 10 (§5.1, P7, P8, S7, F6): Today screen acceptance tests. Full
// TodayScreen/DutyBarHost mounts need Dio/Hive/connectivity_plus platform
// channels that aren't mockable anywhere in this suite (see the note in
// test/offline_queue_test.dart) -- so, matching the established pattern,
// this covers the pure sort/aggregate logic directly and the presentational
// components (DutyBar, TodaySection) via ProviderScope overrides rather than
// a full end-to-end mount.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rudrayani_mobile/core/models/account.dart';
import 'package:rudrayani_mobile/core/theme/app_theme.dart';
import 'package:rudrayani_mobile/core/ui/ui.dart';
import 'package:rudrayani_mobile/features/reminders/reminders_provider.dart';
import 'package:rudrayani_mobile/features/reminders/today_section.dart';
import 'package:rudrayani_mobile/features/today/today_provider.dart';
import 'package:rudrayani_mobile/features/today/today_screen.dart';

Account _account(String id, {bool? workedToday, double? collectedToday, DateTime? ptpDate}) => Account(
      id: id,
      loanNumber: 'LN-$id',
      customerName: 'Customer $id',
      mobileNumber: '9000000000',
      customFields: const {},
      companyName: 'Acme Finance',
      workedToday: workedToday,
      collectedToday: collectedToday,
      ptpDate: ptpDate,
    );

Widget _wrap(Widget child, {List<Override> overrides = const []}) {
  return ProviderScope(
    overrides: overrides,
    child: MaterialApp(theme: buildAppTheme(), home: Scaffold(body: child)),
  );
}

void main() {
  group('sortWithWorkedSunk', () {
    test('pushes worked-today rows after unworked ones, preserving relative order', () {
      final items = [
        _account('a', workedToday: true),
        _account('b', workedToday: false),
        _account('c', workedToday: false),
        _account('d', workedToday: true),
      ];
      final sorted = sortWithWorkedSunk(items);
      expect(sorted.map((a) => a.id).toList(), ['b', 'c', 'a', 'd']);
    });

    test('leaves an all-unworked list untouched', () {
      final items = [_account('a'), _account('b')];
      expect(sortWithWorkedSunk(items).map((a) => a.id).toList(), ['a', 'b']);
    });
  });

  group('workedCountFromLoaded', () {
    test('returns null when no worked row has loaded yet and more pages remain', () {
      final items = [_account('a', workedToday: false), _account('b', workedToday: false)];
      expect(workedCountFromLoaded(items, 10), isNull);
    });

    test('returns zero when everything loaded and none are worked', () {
      final items = [_account('a', workedToday: false), _account('b', workedToday: false)];
      expect(workedCountFromLoaded(items, 2), 0);
    });

    test('derives the exact worked count from the worked/unworked boundary', () {
      // 5 unworked, then worked-to-the-end globally (server sorts worked
      // last) -- total is larger than what's loaded, but the boundary
      // already answers the question without needing the remaining pages.
      final items = [
        _account('1', workedToday: false),
        _account('2', workedToday: false),
        _account('3', workedToday: false),
        _account('4', workedToday: true),
        _account('5', workedToday: true),
      ];
      // total = 20: 3 unworked precede the boundary, so 17 are worked.
      expect(workedCountFromLoaded(items, 20), 17);
    });
  });

  group('collectedTodaySoFar', () {
    test('sums collectedToday across loaded rows, treating null as zero', () {
      final items = [
        _account('a', collectedToday: 500),
        _account('b', collectedToday: null),
        _account('c', collectedToday: 1200.5),
      ];
      expect(collectedTodaySoFar(items), 1700.5);
    });
  });

  group('DutyBar (Phase 10 wiring contract)', () {
    testWidgets('shows the offline icon when offline', (tester) async {
      await tester.pumpWidget(_wrap(
        DutyBar(onDuty: true, shiftDuration: const Duration(hours: 1), offline: true, onPunchPressed: () {}),
      ));
      expect(find.byIcon(Icons.cloud_off), findsOneWidget);
    });

    testWidgets('hides the offline icon when online', (tester) async {
      await tester.pumpWidget(_wrap(
        DutyBar(onDuty: true, shiftDuration: const Duration(hours: 1), offline: false, onPunchPressed: () {}),
      ));
      expect(find.byIcon(Icons.cloud_off), findsNothing);
    });

    testWidgets('shows the pending-sync count', (tester) async {
      await tester.pumpWidget(_wrap(
        DutyBar(onDuty: true, shiftDuration: Duration.zero, pendingSyncCount: 3, onPunchPressed: () {}),
      ));
      expect(find.text('3 to sync'), findsOneWidget);
    });

    testWidgets('the punch button label follows duty state and fires the callback', (tester) async {
      var pressed = false;
      await tester.pumpWidget(_wrap(
        DutyBar(onDuty: true, shiftDuration: Duration.zero, onPunchPressed: () => pressed = true),
      ));
      expect(find.text('Punch Out'), findsOneWidget);
      await tester.tap(find.text('Punch Out'));
      expect(pressed, isTrue);
    });
  });

  group('TodaySection heroMode (PTP follow-ups, §5.1)', () {
    testWidgets('renders and expands the PTP/reminder section when items exist', (tester) async {
      await tester.pumpWidget(_wrap(
        const TodaySection(heroMode: true),
        overrides: [
          remindersTodayProvider.overrideWith((ref) async => <Map<String, dynamic>>[]),
          ptpsDueTodayProvider.overrideWith((ref) async => [
                {
                  'customer_name': 'Overdue Customer',
                  'amount': '1000',
                  'promised_date': DateTime.now().subtract(const Duration(days: 1)).toIso8601String(),
                },
              ]),
        ],
      ));
      await tester.pumpAndSettle();
      expect(find.text("Today's Actions"), findsOneWidget);
      expect(find.text('Overdue Customer'), findsOneWidget);
    });

    testWidgets('collapses when the header is tapped', (tester) async {
      await tester.pumpWidget(_wrap(
        const TodaySection(heroMode: true),
        overrides: [
          remindersTodayProvider.overrideWith((ref) async => <Map<String, dynamic>>[]),
          ptpsDueTodayProvider.overrideWith((ref) async => [
                {
                  'customer_name': 'Due Customer',
                  'amount': '500',
                  'promised_date': DateTime.now().toIso8601String(),
                },
              ]),
        ],
      ));
      await tester.pumpAndSettle();
      expect(find.text('Due Customer'), findsOneWidget);

      await tester.tap(find.text("Today's Actions"));
      await tester.pumpAndSettle();
      expect(find.text('Due Customer'), findsNothing);
    });

    testWidgets('renders nothing when there is nothing due', (tester) async {
      await tester.pumpWidget(_wrap(
        const TodaySection(heroMode: true),
        overrides: [
          remindersTodayProvider.overrideWith((ref) async => <Map<String, dynamic>>[]),
          ptpsDueTodayProvider.overrideWith((ref) async => <Map<String, dynamic>>[]),
        ],
      ));
      await tester.pumpAndSettle();
      expect(find.text("Today's Actions"), findsNothing);
    });
  });
}
