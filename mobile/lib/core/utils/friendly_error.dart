import 'package:dio/dio.dart';

/// Maps any exception from an API call to a short, actionable message safe
/// to show a field agent. Before this existed, raw exception text --
/// including Dio internals and, in at least one place, the API's internal
/// base URL -- was rendered directly in at least a dozen screens.
String friendlyError(Object e) {
  if (e is DioException) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.connectionError:
        return 'No network connection — try again once you have signal.';
      case DioExceptionType.cancel:
        return 'Cancelled.';
      default:
        break;
    }
    final data = e.response?.data;
    final serverMsg = data is Map ? data['error'] as String? : null;
    if (serverMsg != null && serverMsg.isNotEmpty) return serverMsg;
    final status = e.response?.statusCode;
    if (status != null) return 'Something went wrong (error $status). Please try again.';
    return 'Something went wrong. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}
