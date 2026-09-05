import '../utils/parser.dart';

/// The one customer-entity shape (§7.1) -- replaces the worklist-payload
/// `Customer` model and the untyped `Map<String, dynamic>` the old
/// `customerDetailProvider` returned for the detail header. Both endpoints
/// (`GET /worklist` and `GET /worklist/:id`) return this same field set, so
/// one model now covers the worklist row, the detail header, and every
/// screen in between.
///
/// Deliberately does NOT carry the customer-360 payload (trail/payments/
/// field-visits/attachments) -- that's a separate, much larger fetch used
/// only by the History timeline, and stays a raw Map there (see
/// `customer_detail_provider.dart`).
class Account {
  final String id;
  final String loanNumber;
  final String customerName;
  final String mobileNumber;
  final String? product;
  final String? bucket;
  final double? dueAmount;
  final double? pos;
  final double? emi;
  final int? dpd;
  final String? address;
  final Map<String, dynamic> customFields;
  final String companyName;
  final String? branchName;
  final String? lastRemark;
  final DateTime? lastCallAt;
  final String? lastResultCode;
  final double? ptpAmount;
  final DateTime? ptpDate;
  final DateTime? nextActionDate;
  final bool normalizedPending;
  /// Null on `GET /worklist/:id` (not selected there) -- only meaningful on
  /// the worklist list, which is the only place "worked today" is rendered.
  final bool? workedToday;
  final double? collectedToday;
  // Phase 7 (§4.10) already filters `/worklist` to status='active' server
  // side, so these mostly matter for forward-compatibility.
  final String status;
  final DateTime? recalledAt;

  const Account({
    required this.id,
    required this.loanNumber,
    required this.customerName,
    required this.mobileNumber,
    this.product,
    this.bucket,
    this.dueAmount,
    this.pos,
    this.emi,
    this.dpd,
    this.address,
    required this.customFields,
    required this.companyName,
    this.branchName,
    this.lastRemark,
    this.lastCallAt,
    this.lastResultCode,
    this.ptpAmount,
    this.ptpDate,
    this.nextActionDate,
    this.normalizedPending = false,
    this.workedToday,
    this.collectedToday,
    this.status = 'active',
    this.recalledAt,
  });

  factory Account.fromJson(Map<String, dynamic> j) => Account(
        id: j['id'] as String,
        loanNumber: j['loan_number'] as String,
        customerName: j['customer_name'] as String,
        mobileNumber: (j['mobile_number'] as String?) ?? '',
        product: j['product'] as String?,
        bucket: j['bucket'] as String?,
        dueAmount: parseDouble(j['due_amount']),
        pos: parseDouble(j['pos']),
        emi: parseDouble(j['emi']),
        dpd: (j['dpd'] as num?)?.toInt(),
        address: j['address'] as String?,
        customFields: (j['custom_fields'] as Map<String, dynamic>?) ?? {},
        companyName: j['company_name'] as String,
        branchName: j['branch_name'] as String?,
        lastRemark: j['last_remark'] as String?,
        lastCallAt: j['last_call_at'] != null ? DateTime.parse(j['last_call_at'] as String) : null,
        lastResultCode: j['last_result_code'] as String?,
        ptpAmount: parseDouble(j['ptp_amount']),
        ptpDate: j['ptp_date'] != null ? DateTime.parse(j['ptp_date'] as String) : null,
        nextActionDate:
            j['next_action_date'] != null ? DateTime.parse(j['next_action_date'] as String) : null,
        normalizedPending: j['normalized_pending'] as bool? ?? false,
        workedToday: j['worked_today'] as bool?,
        collectedToday: parseDouble(j['collected_today']),
        status: j['status'] as String? ?? 'active',
        recalledAt: j['recalled_at'] != null ? DateTime.parse(j['recalled_at'] as String) : null,
      );
}
