import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/api/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/friendly_error.dart';
import '../../../core/widgets/state_views.dart';

const Map<String, String> _designationLabels = {
  'agency_admin': 'Agency Admin',
  'operations_manager': 'Operations Manager',
  'branch_manager': 'Branch Manager',
  'telecaller': 'Telecaller',
  'field_agent': 'Field Agent',
};

const Map<String, IconData> _activityIcons = {
  'call': Icons.phone,
  'payment': Icons.payments,
  'ptp': Icons.description,
  'field_visit': Icons.location_on,
};

const Map<String, String> _activityLabels = {
  'call': 'Call logged',
  'payment': 'Payment collected',
  'ptp': 'PTP',
  'field_visit': 'Field visit',
};

class EmployeeDetailScreen extends ConsumerStatefulWidget {
  final String employeeId;
  const EmployeeDetailScreen({super.key, required this.employeeId});

  @override
  ConsumerState<EmployeeDetailScreen> createState() => _EmployeeDetailScreenState();
}

class _EmployeeDetailScreenState extends ConsumerState<EmployeeDetailScreen> {
  Map<String, dynamic>? _employee;
  List<Map<String, dynamic>>? _activity;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final api = ref.read(apiClientProvider);
      final res = await api.get('/employees/${widget.employeeId}');
      final employee = res.data['employee'] as Map<String, dynamic>;
      if (mounted) setState(() => _employee = employee);

      // Only agent-type rows (plain telecaller/field_agent, or a
      // branch_manager with agent_type set) have collections activity to
      // show -- everyone else's feed would just be empty.
      final capabilities = (employee['capabilities'] as List?)?.cast<String>() ?? const [];
      if (capabilities.contains('telecaller') || capabilities.contains('field_agent')) {
        final actRes = await api.get('/reports/agent-activity', query: {
          'agent_id': widget.employeeId,
          'limit': '20',
        });
        final activity = (actRes.data['activity'] as List).cast<Map<String, dynamic>>();
        if (mounted) setState(() => _activity = activity);
      } else {
        if (mounted) setState(() => _activity = const []);
      }
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Employee Details')),
        body: ErrorState(message: _error!, onRetry: _load),
      );
    }

    if (_employee == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Employee Details')),
        body: const LoadingState(),
      );
    }

    final emp = _employee!;
    final name = emp['full_name'] as String? ?? 'Unknown';
    final email = emp['email'] as String? ?? 'No email';
    final phone = emp['phone'] as String? ?? 'No phone';
    final designation = emp['designation'] as String?;
    final role = _designationLabels[designation] ?? designation ?? 'Unknown role';
    final agentType = emp['agent_type'] as String?;
    final isActive = emp['is_active'] == true;

    return Scaffold(
      appBar: AppBar(title: Text(name)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 40,
                backgroundColor: AppColors.primary,
                child: Text(
                  name[0].toUpperCase(),
                  style: const TextStyle(fontSize: 32, color: AppColors.onPrimary),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 4),
                    Text(role.toUpperCase(), style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.bold)),
                    if (agentType != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        'Also works as ${_designationLabels[agentType] ?? agentType}',
                        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
                      ),
                    ],
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: isActive ? AppColors.successContainer : AppColors.errorContainer,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        isActive ? 'Active' : 'Inactive',
                        style: TextStyle(
                          fontSize: 12,
                          color: isActive ? AppColors.successStrong : AppColors.error,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          const Text('Contact Information', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.email),
                  title: Text(email),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.phone),
                  title: Text(phone),
                  trailing: phone != 'No phone' ? const Icon(Icons.call, color: AppColors.success) : null,
                  onTap: phone != 'No phone'
                      ? () async {
                          final uri = Uri(scheme: 'tel', path: phone);
                          if (await canLaunchUrl(uri)) await launchUrl(uri);
                        }
                      : null,
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          const Text('Recent Activity', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (_activity == null)
            const Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()))
          else if (_activity!.isEmpty)
            const Text('No recent activity', style: TextStyle(color: AppColors.textSecondary))
          else
            Card(
              child: Column(
                children: [
                  for (final a in _activity!)
                    ListTile(
                      leading: Icon(_activityIcons[a['kind']] ?? Icons.circle, color: AppColors.primary),
                      title: Text(_activityLabels[a['kind']] ?? a['kind'] as String? ?? 'Activity'),
                      subtitle: Text(
                        '${a['customer_name'] ?? ''} · ${a['loan_number'] ?? ''}'
                        '${a['detail'] != null ? '\n${a['detail']}' : ''}',
                      ),
                      isThreeLine: a['detail'] != null,
                      trailing: a['at'] != null
                          ? Text(
                              DateFormat('dd MMM, HH:mm').format(DateTime.parse(a['at'] as String).toLocal()),
                              style: const TextStyle(fontSize: 11, color: AppColors.textTertiary),
                            )
                          : null,
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
