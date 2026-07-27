import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api/api_client.dart';
import '../../core/offline/offline_queue.dart';
import '../../core/tracking/attendance_provider.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/widgets/state_views.dart';
import '../worklist/worklist_provider.dart';

/// GPS older than this or with a worse accuracy than this is still attached
/// to the visit (better than nothing), but the agent is shown exactly how
/// stale/imprecise it is rather than a silent "location captured" implying
/// the point can be trusted at face value.
const _gpsStaleAfter = Duration(minutes: 20);
const _gpsPoorAccuracyMeters = 100;

/// Field-visit evidence (brief §8): a photo of the visit, an optional remark,
/// and the GPS point. (Customer signature was dropped per product decision
/// 2026-07-06 — the photo is the required evidence.)
class FieldVisitScreen extends ConsumerStatefulWidget {
  final String customerId;
  const FieldVisitScreen({super.key, required this.customerId});

  @override
  ConsumerState<FieldVisitScreen> createState() => _FieldVisitScreenState();
}

enum _VisitOutcome { met, noAccess }

class _FieldVisitScreenState extends ConsumerState<FieldVisitScreen> {
  final _remarkCtrl = TextEditingController();
  File? _photo;
  bool _loading = false;
  String? _error;
  _VisitOutcome _outcome = _VisitOutcome.met;
  Position? _position;
  bool _locating = true;

  @override
  void initState() {
    super.initState();
    _refreshGps();
  }

  @override
  void dispose() {
    _remarkCtrl.dispose();
    super.dispose();
  }

  Future<void> _refreshGps() async {
    setState(() => _locating = true);
    final pos = await _tryGps();
    if (mounted) setState(() { _position = pos; _locating = false; });
  }

  Future<void> _pickPhoto(ImageSource source) async {
    final xfile = await ImagePicker()
        .pickImage(source: source, imageQuality: 80, maxWidth: 1920);
    if (xfile != null) setState(() => _photo = File(xfile.path));
  }

  Future<Position?> _tryGps() async {
    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
    } catch (_) {
      return Geolocator.getLastKnownPosition();
    }
  }

  /// null position, or older/less precise than the thresholds above -- shown
  /// to the agent instead of silently attaching a point that might be from
  /// another town (the previous behaviour: fall back with no check at all).
  String get _gpsStatusText {
    if (_locating) return 'Getting location…';
    final pos = _position;
    if (pos == null) return 'No location available for this visit';
    final age = DateTime.now().difference(pos.timestamp);
    final stale = age > _gpsStaleAfter;
    final poor = pos.accuracy > _gpsPoorAccuracyMeters;
    if (!stale && !poor) return 'Location captured (±${pos.accuracy.round()}m)';
    final parts = <String>[];
    if (stale) parts.add('${age.inMinutes} min old');
    if (poor) parts.add('±${pos.accuracy.round()}m accuracy');
    return 'Location may be unreliable (${parts.join(', ')})';
  }

  Future<void> _submit() async {
    if (!ref.read(attendanceProvider).punchedIn) {
      setState(() => _error = 'You must be punched in to record a field visit');
      return;
    }
    if (_outcome == _VisitOutcome.met && _photo == null) {
      setState(() => _error = 'Add a photo of the visit');
      return;
    }
    if (_outcome == _VisitOutcome.noAccess && _remarkCtrl.text.trim().length < 3) {
      setState(() => _error = 'Describe what happened (e.g. door locked, nobody home)');
      return;
    }

    setState(() { _loading = true; _error = null; });
    try {
      final pos = _position;

      // One key for both paths (direct send / offline queue).
      final payload = <String, dynamic>{
        'customer_id': widget.customerId,
        if (_remarkCtrl.text.trim().isNotEmpty) 'remark': _remarkCtrl.text.trim(),
        if (pos != null) 'lat': pos.latitude,
        if (pos != null) 'lng': pos.longitude,
        'client_key': OfflineQueueNotifier.newClientKey(),
      };

      final api = ref.read(apiClientProvider);
      try {
        final form = FormData.fromMap({
          ...payload,
          if (_photo != null)
            'photo': await MultipartFile.fromFile(_photo!.path,
                filename: 'visit.jpg', contentType: DioMediaType('image', 'jpeg')),
        });
        await api.postForm('/field-visits', form);
      } catch (e) {
        if (!isOfflineError(e)) rethrow;
        final photoPath = _photo != null ? await OfflineQueueNotifier.persistPhoto(_photo!.path) : null;
        await ref.read(offlineQueueProvider.notifier).enqueue(QueuedAction(
              clientKey: payload['client_key'] as String,
              type: 'field_visit',
              payload: payload,
              photoPath: photoPath,
              createdAt: DateTime.now(),
            ));
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('No network — visit saved offline, will sync automatically'),
              backgroundColor: AppColors.warning,
            ),
          );
          context.pop();
        }
        return;
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Field visit recorded!'), backgroundColor: AppColors.success),
        );
        context.pop();
      }
    } catch (e) {
      setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final customerAsync = ref.watch(customerByIdProvider(widget.customerId));
    final punchedIn = ref.watch(attendanceProvider).punchedIn;
    final metOutcome = _outcome == _VisitOutcome.met;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.onPrimary,
        title: Text(
          customerAsync.maybeWhen(
            data: (c) => 'Field Visit — ${c.customerName}',
            orElse: () => 'Field Visit',
          ),
        ),
      ),
      body: !punchedIn
          ? ErrorState(
              icon: Icons.lock_clock,
              message: 'You must be punched in to record a field visit.',
              onRetry: () => ref.read(attendanceProvider.notifier).punchIn(),
              retryLabel: 'Punch In',
            )
          : SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('What happened?',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            const SizedBox(height: 8),
            // Merges outcome capture into this screen -- previously the
            // agent had to separately open Log Call and pick channel FV
            // just to record the result, doubling the trip for one visit.
            SegmentedButton<_VisitOutcome>(
              style: SegmentedButton.styleFrom(minimumSize: const Size(64, AppDimens.tapTarget)),
              segments: const [
                ButtonSegment(value: _VisitOutcome.met, label: Text('Met customer'), icon: Icon(Icons.person)),
                ButtonSegment(value: _VisitOutcome.noAccess, label: Text('Could not access'), icon: Icon(Icons.door_front_door_outlined)),
              ],
              selected: {_outcome},
              onSelectionChanged: (s) => setState(() => _outcome = s.first),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Icon(
                  _locating ? Icons.location_searching : Icons.location_on_outlined,
                  size: 16,
                  color: AppColors.textTertiary,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(_gpsStatusText, style: const TextStyle(fontSize: 12, color: AppColors.textTertiary)),
                ),
                if (!_locating)
                  TextButton(onPressed: _refreshGps, child: const Text('Retry', style: TextStyle(fontSize: 12))),
              ],
            ),
            const SizedBox(height: 16),
            Text(metOutcome ? 'Visit Photo *' : 'Visit Photo (optional)',
                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            const SizedBox(height: 8),
            if (_photo != null) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.file(_photo!, height: 180, fit: BoxFit.cover),
              ),
              TextButton.icon(
                icon: const Icon(Icons.delete),
                label: const Text('Remove photo'),
                onPressed: () => setState(() => _photo = null),
                style: TextButton.styleFrom(foregroundColor: AppColors.error),
              ),
            ] else
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.camera_alt),
                      label: const Text('Camera'),
                      onPressed: () => _pickPhoto(ImageSource.camera),
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, AppDimens.tapTarget)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.photo_library),
                      label: const Text('Gallery'),
                      onPressed: () => _pickPhoto(ImageSource.gallery),
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, AppDimens.tapTarget)),
                    ),
                  ),
                ],
              ),
            const SizedBox(height: 16),
            TextField(
              controller: _remarkCtrl,
              maxLines: 2,
              decoration: InputDecoration(
                labelText: metOutcome ? 'Remark (optional)' : 'What happened? *',
                hintText: metOutcome ? null : 'e.g. door locked, nobody home, refused to open',
                border: const OutlineInputBorder(),
              ),
            ),
          ],
        ),
      ),
      // Persistent save bar (design brief 3.7) -- the primary action
      // previously sat at the bottom of a SingleChildScrollView. Hidden
      // entirely while punched out; there is nothing to save yet.
      bottomNavigationBar: !punchedIn ? null : SafeArea(
        minimum: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(_error!, style: const TextStyle(color: AppColors.error)),
              ),
            SizedBox(
              height: AppDimens.tapTarget,
              width: double.infinity,
              child: ElevatedButton.icon(
                icon: _loading
                    ? const SizedBox(
                        width: 18, height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.onPrimary))
                    : const Icon(Icons.save),
                label: Text(_loading ? 'Saving…' : 'Save Visit'),
                onPressed: _loading ? null : _submit,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: AppColors.onPrimary,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
