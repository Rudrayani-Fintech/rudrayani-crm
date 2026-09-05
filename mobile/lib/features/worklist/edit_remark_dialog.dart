import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';

/// Same-day (rolling 24h) owner-only remark edit -- mobile counterpart to
/// web's EditRemarkModal. Distinct from web's correction-request flow
/// (manager-approved, no time limit -- mobile dropped its own copy of this
/// UI in Phase 13, P1: web only); for a call_log this edits only the
/// free-text tail (extra_remark), never the disposition or structured fields.
Future<void> showEditRemarkDialog(
  BuildContext context,
  WidgetRef ref, {
  required String recordType, // 'call_log' | 'field_visit'
  required String recordId,
  required String currentText,
  required VoidCallback onSaved,
}) async {
  final controller = TextEditingController(text: currentText);

  final result = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Edit remark'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'You can only edit this within 24 hours of logging it. After that, use "Report an error" instead.',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: controller,
            maxLines: 3,
            autofocus: true,
            decoration: const InputDecoration(border: OutlineInputBorder()),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
      ],
    ),
  );

  if (result != true || !context.mounted) return;

  final path = recordType == 'field_visit'
      ? '/field-visits/$recordId/remark'
      : '/call-logs/$recordId/remark';
  final bodyKey = recordType == 'field_visit' ? 'remark' : 'extra_remark';

  try {
    await ref.read(apiClientProvider).patch(path, data: {bodyKey: controller.text.trim()});
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Remark updated'), backgroundColor: AppColors.success),
      );
    }
    onSaved();
  } on DioException catch (e) {
    if (context.mounted) {
      final msg =
          e.response?.data is Map && (e.response?.data as Map)['error'] != null
          ? (e.response!.data as Map)['error'].toString()
          : 'Could not save — check your connection';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: AppColors.error));
    }
  }
}
