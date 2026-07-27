import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// India-only heuristic: a bare 10-digit number gets the country code
/// prefixed for wa.me, which requires it. Shared so it isn't re-derived per
/// screen (payment_screen.dart, customer_detail_screen.dart, ptps_screen.dart
/// all need the same normalization for the same reason).
String whatsappDigits(String mobileNumber) {
  final digits = mobileNumber.replaceAll(RegExp(r'\D'), '');
  if (digits.length == 10) return '91$digits';
  return digits;
}

/// Opens WhatsApp (if [viaWhatsApp]) or the SMS app pre-filled with
/// [message] for [mobileNumber]. Shows a SnackBar if neither app is
/// reachable, matching the existing payment-receipt share behaviour.
Future<void> shareMessage(
  BuildContext context, {
  required String mobileNumber,
  required String message,
  required bool viaWhatsApp,
}) async {
  final uri = viaWhatsApp
      ? Uri.parse('https://wa.me/${whatsappDigits(mobileNumber)}?text=${Uri.encodeComponent(message)}')
      : Uri(scheme: 'sms', path: mobileNumber, queryParameters: {'body': message});
  if (await canLaunchUrl(uri)) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  } else if (context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(viaWhatsApp ? 'WhatsApp is not installed' : 'Cannot open messaging app')),
    );
  }
}
