import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import 'ui.dart';

/// Phase 8 (§6) visual-review gallery: renders every design-system
/// component with representative sample data. Not part of the app's normal
/// navigation flow -- reached only via the dev route `/dev/gallery` for
/// reviewing the library in isolation before any feature screen uses it.
class ComponentGalleryScreen extends StatefulWidget {
  const ComponentGalleryScreen({super.key});

  @override
  State<ComponentGalleryScreen> createState() => _ComponentGalleryScreenState();
}

class _ComponentGalleryScreenState extends State<ComponentGalleryScreen> {
  bool _dutyOn = true;
  bool _chipSelected = false;
  final Set<String> _selectedChips = {'ptp'};

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: 'Component gallery',
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          const _Label('DutyBar'),
          DutyBar(
            onDuty: _dutyOn,
            shiftDuration: const Duration(hours: 4, minutes: 12),
            pendingSyncCount: 3,
            offline: false,
            onPunchPressed: () => setState(() => _dutyOn = !_dutyOn),
          ),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppSectionHeader'),
          const AppSectionHeader(title: 'Section title'),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppCard'),
          const AppCard(child: Text('Card content sits here.')),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppStatTile'),
          Row(
            children: [
              Expanded(
                child: AppStatTile(
                  label: 'Collected today',
                  value: const AppMoney(84250),
                  icon: Icons.payments_outlined,
                  accentColor: AppColors.success,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: AppStatTile(
                  label: 'Contacted',
                  value: const Text('12'),
                  icon: Icons.call_outlined,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppListRow (56px minimum height)'),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                AppListRow(
                  leading: const Icon(Icons.person_outline),
                  title: const Text('Ramesh Kumar'),
                  subtitle: const Text('Loan RC-00123 · Bucket 30'),
                  trailing: const AppMoney(45000),
                  onTap: () {},
                ),
                const Divider(height: 1),
                AppListRow(
                  leading: const Icon(Icons.person_outline),
                  title: const Text('Sita Devi'),
                  subtitle: const Text('Loan RC-00456 · Bucket X'),
                  trailing: const AppMoney(12500),
                  onTap: () {},
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppMoney (tabular figures)'),
          const AppMoney(1284500),
          const SizedBox(height: AppSpacing.xs),
          const AppMoney(10400000, compact: true),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppChipGroup'),
          AppChipGroup<String>(
            options: const [
              AppChipOption(value: 'ptp', label: 'Promise to Pay'),
              AppChipOption(value: 'rnr', label: 'Ringing Not Responding'),
              AppChipOption(value: 'refused', label: 'Refused to Pay'),
            ],
            selected: _selectedChips,
            onSelected: (v) => setState(() {
              _selectedChips.clear();
              _selectedChips.add(v);
            }),
          ),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppFormField'),
          const AppFormField(label: 'Remark', hint: 'Enter a note'),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppPrimaryButton / AppSecondaryButton (48px minimum height)'),
          AppPrimaryButton(label: 'Save', onPressed: () {}),
          const SizedBox(height: AppSpacing.sm),
          AppSecondaryButton(label: 'Cancel', onPressed: () {}),
          const SizedBox(height: AppSpacing.sm),
          AppPrimaryButton(
            label: 'Toggle chip demo',
            onPressed: () => setState(() => _chipSelected = !_chipSelected),
            icon: _chipSelected ? Icons.check : Icons.add,
          ),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppLoadingState'),
          const SizedBox(height: 100, child: AppLoadingState(label: 'Loading…')),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppEmptyState'),
          const SizedBox(
            height: 160,
            child: AppEmptyState(message: 'Nothing here yet', hint: 'Check back later'),
          ),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppErrorState'),
          SizedBox(
            height: 160,
            child: AppErrorState(message: 'Could not load this list.', onRetry: () {}),
          ),
          const SizedBox(height: AppSpacing.xl),

          const _Label('AppInlineErrorNote'),
          AppInlineErrorNote(message: 'Failed to sync one item.', onRetry: () {}),
          const SizedBox(height: AppSpacing.xl),
        ],
      ),
    );
  }
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Text(
        text,
        style: Theme.of(context)
            .textTheme
            .labelMedium
            ?.copyWith(color: AppColors.textTertiary, fontWeight: FontWeight.w700),
      ),
    );
  }
}
