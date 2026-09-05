import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/offline/connectivity_provider.dart';
import '../../core/offline/offline_queue.dart';
import '../../core/theme/app_theme.dart';
import '../../core/tracking/attendance_provider.dart';
import '../../core/ui/duty_bar.dart';

/// Wires the presentational [DutyBar] (Phase 8) to live state (Phase 10,
/// §5.1/S7): duty status + running shift timer from [attendanceProvider],
/// pending-sync count from [offlineQueueProvider], and the offline alert
/// from [isOfflineProvider]. Mounted once, above every tab's content, so
/// punch-out is reachable in one tap regardless of which tab is active --
/// previously only reachable from the Account tab.
class DutyBarHost extends ConsumerStatefulWidget {
  const DutyBarHost({super.key});

  @override
  ConsumerState<DutyBarHost> createState() => _DutyBarHostState();
}

class _DutyBarHostState extends ConsumerState<DutyBarHost> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // The shift timer has no provider of its own to watch -- it's a pure
    // function of "now minus punchInAt" -- so a periodic rebuild is the
    // simplest way to keep it advancing on screen. A minute's resolution is
    // all the "4h 12m" display shows anyway.
    _ticker = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _handlePunch(AttendanceState att) async {
    final notifier = ref.read(attendanceProvider.notifier);
    if (att.punchedIn) {
      await notifier.punchOut();
    } else {
      await notifier.punchIn();
    }
    final error = ref.read(attendanceProvider).error;
    if (error != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error), backgroundColor: AppColors.error),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final att = ref.watch(attendanceProvider);
    final pending = ref.watch(offlineQueueProvider.select((s) => s.pending));
    final offline = ref.watch(isOfflineProvider).valueOrNull ?? false;
    final shiftDuration =
        att.punchedIn && att.punchInAt != null ? DateTime.now().difference(att.punchInAt!) : Duration.zero;

    return DutyBar(
      onDuty: att.punchedIn,
      shiftDuration: shiftDuration,
      pendingSyncCount: pending,
      offline: offline,
      onPunchPressed: att.busy ? () {} : () => _handlePunch(att),
    );
  }
}
