import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// One selectable chip within an [AppChipGroup].
class AppChipOption<T> {
  final T value;
  final String label;
  const AppChipOption({required this.value, required this.label});
}

/// A wrapped grid of selectable pills -- built for the Log Visit trail-code
/// picker (grouped, most-used-first) and any other single/multi-select pill
/// grid (e.g. the disposition pill grid). Each chip meets the
/// [AppDimens.tapTarget] minimum height regardless of its label length.
class AppChipGroup<T> extends StatelessWidget {
  final List<AppChipOption<T>> options;
  final Set<T> selected;
  final void Function(T value) onSelected;
  final bool multiSelect;

  const AppChipGroup({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelected,
    this.multiSelect = false,
  });

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      children: [
        for (final option in options)
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: AppDimens.tapTarget),
            child: Align(
              alignment: Alignment.center,
              child: ChoiceChip(
                label: Text(option.label),
                selected: selected.contains(option.value),
                onSelected: (_) => onSelected(option.value),
                selectedColor: AppColors.primarySurface,
                labelStyle: TextStyle(
                  color: selected.contains(option.value)
                      ? AppColors.primary
                      : AppColors.textSecondary,
                  fontWeight: selected.contains(option.value)
                      ? FontWeight.w600
                      : FontWeight.normal,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(AppRadius.full),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
