import 'account.dart';

/// Phase 9 (§7.1): the one customer-entity shape moved to `account.dart` as
/// `Account` (a strict field superset of the old `Customer` -- every
/// existing field kept its name and type, only new fields were added). This
/// is a class alias so every existing constructor call, `.fromJson`, and
/// field access on the old name keeps compiling unchanged. New code should
/// import `core/models/account.dart` and use `Account` directly.
typedef Customer = Account;
