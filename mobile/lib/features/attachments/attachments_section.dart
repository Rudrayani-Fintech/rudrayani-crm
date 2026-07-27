import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import '../../../core/theme/app_theme.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import '../../core/offline/offline_queue.dart';
import '../../core/utils/friendly_error.dart';
import '../../core/widgets/state_views.dart';
import 'attachments_provider.dart';

final _date = DateFormat('dd MMM yyyy');

/// Documents section on the customer detail screen: list + upload (photos
/// via camera/gallery, PDFs via file_picker). Photos queue offline like
/// payment/field-visit photos; PDFs require connectivity (brief: v1 keeps
/// this simple rather than adding a second large-file offline path).
class AttachmentsSection extends ConsumerStatefulWidget {
  final String customerId;
  const AttachmentsSection({super.key, required this.customerId});

  @override
  ConsumerState<AttachmentsSection> createState() => _AttachmentsSectionState();
}

class _AttachmentsSectionState extends ConsumerState<AttachmentsSection> {
  bool _uploading = false;

  Future<void> _uploadPhoto(ImageSource source) async {
    final picker = ImagePicker();
    final xfile = await picker.pickImage(
      source: source,
      imageQuality: 80,
      maxWidth: 1920,
    );
    if (xfile == null) return;

    setState(() => _uploading = true);
    try {
      final synced = await ref
          .read(attachmentsControllerProvider)
          .uploadPhoto(customerId: widget.customerId, photoPath: xfile.path);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              synced
                  ? 'Photo uploaded'
                  : 'No network — will sync automatically',
            ),
            backgroundColor: synced ? AppColors.success : AppColors.warning,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Upload failed: ${friendlyError(e)}'),
            backgroundColor: AppColors.error,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _uploadPdf() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['pdf'],
    );
    final path = result?.files.single.path;
    if (path == null) return;

    setState(() => _uploading = true);
    try {
      await ref
          .read(attachmentsControllerProvider)
          .uploadPdf(customerId: widget.customerId, file: File(path));
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Document uploaded'),
            backgroundColor: AppColors.success,
          ),
        );
      }
    } catch (e) {
      final msg = isOfflineError(e)
          ? 'PDF upload needs a connection — try again when online'
          : 'Upload failed: ${friendlyError(e)}';
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg), backgroundColor: AppColors.error),
        );
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final attachments = ref.watch(attachmentsProvider(widget.customerId));

    return Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'Documents',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                    color: AppColors.primary,
                  ),
                ),
                if (_uploading)
                  const SizedBox(
                    height: 16,
                    width: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            const Divider(),
            attachments.when(
              loading: () => const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: LinearProgressIndicator(),
              ),
              error: (e, _) => InlineErrorNote(
                message: 'Could not load documents: ${friendlyError(e)}',
                onRetry: () => ref.invalidate(attachmentsProvider(widget.customerId)),
              ),
              data: (list) => list.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text(
                        'No documents uploaded yet',
                        style: TextStyle(fontSize: 12, color: AppColors.textTertiary),
                      ),
                    )
                  : Column(
                      children: list.map((a) {
                        final isPhoto = a['kind'] == 'photo';
                        return ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(
                            isPhoto
                                ? Icons.image_outlined
                                : Icons.picture_as_pdf_outlined,
                            color: AppColors.primary,
                          ),
                          title: Text(
                            a['file_name'] as String,
                            style: const TextStyle(fontSize: 13),
                          ),
                          subtitle: Text(
                            '${a['uploaded_by_name']} · ${_date.format(DateTime.parse(a['created_at'] as String))}'
                            '${(a['note'] as String?)?.isNotEmpty == true ? ' · ${a['note']}' : ''}',
                            style: const TextStyle(
                              fontSize: 11,
                              color: AppColors.textTertiary,
                            ),
                          ),
                        );
                      }).toList(),
                    ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.camera_alt, size: 16),
                    label: const Text('Camera', style: TextStyle(fontSize: 12)),
                    onPressed: _uploading
                        ? null
                        : () => _uploadPhoto(ImageSource.camera),
                    style: OutlinedButton.styleFrom(
                      // Design brief: 48px strict minimum tap target — this
                      // previously shrank to 36px.
                      minimumSize: const Size(0, AppDimens.tapTarget),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.photo_library, size: 16),
                    label: const Text(
                      'Gallery',
                      style: TextStyle(fontSize: 12),
                    ),
                    onPressed: _uploading
                        ? null
                        : () => _uploadPhoto(ImageSource.gallery),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, AppDimens.tapTarget),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.picture_as_pdf, size: 16),
                    label: const Text('PDF', style: TextStyle(fontSize: 12)),
                    onPressed: _uploading ? null : _uploadPdf,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, AppDimens.tapTarget),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
