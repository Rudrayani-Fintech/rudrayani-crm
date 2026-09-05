import '../ui/app_state_views.dart';

/// Phase 8 (§6): the real implementations moved to `core/ui/app_state_views.dart`
/// as `AppLoadingState`/`AppEmptyState`/`AppErrorState`/`AppInlineErrorNote` --
/// these are class aliases so every existing call site keeps compiling
/// unchanged. New code should import `core/ui/app_state_views.dart` and use
/// the `App*` names directly; these aliases exist only for the screens that
/// haven't been migrated yet (Phase 8 does not touch feature screens).
typedef LoadingState = AppLoadingState;
typedef EmptyState = AppEmptyState;
typedef ErrorState = AppErrorState;
typedef InlineErrorNote = AppInlineErrorNote;
