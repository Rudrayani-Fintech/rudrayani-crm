import 'package:flutter/material.dart';
import '../../core/theme/app_theme.dart';

/// Shared building blocks for the three role dashboards added in Phase 12
/// (Team Leader / Telecaller / Field Executive) -- kept in one place so every
/// new dashboard card follows the same design-token discipline from the
/// start (Phase 11 palette/spacing/tabular-nums) instead of each screen
/// re-inventing its own stat tile.

/// A single KPI tile: label, headline value, optional sub-line and accent
/// stripe. Mirrors the web's SummaryStat (frontend/src/components/dashboard/
/// SummaryStat.tsx) so the two clients read as one system.
class DashboardStatCard extends StatelessWidget {
  final String label;
  final String value;
  final String? sub;
  final Color? accent;
  final VoidCallback? onTap;
  const DashboardStatCard({super.key, required this.label, required this.value, this.sub, this.accent, this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.md),
      child: Container(
        constraints: const BoxConstraints(minHeight: AppDimens.listRow),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
        decoration: BoxDecoration(
          color: AppColors.primarySurface,
          borderRadius: BorderRadius.circular(AppRadius.md),
          border: Border(left: BorderSide(color: accent ?? AppColors.primary, width: 3)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              label,
              style: const TextStyle(fontSize: 14, color: AppColors.textSecondary, letterSpacing: 0.3),
            ),
            const SizedBox(height: 2),
            Text(
              value,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.primaryDark)
                  .tabular,
            ),
            if (sub != null) ...[
              const SizedBox(height: 2),
              Text(sub!, style: const TextStyle(fontSize: 14, color: AppColors.textSecondary).tabular),
            ],
          ],
        ),
      ),
    );
  }
}

/// A 2-column grid of [DashboardStatCard]s -- the layout every dashboard in
/// this phase uses for its KPI row.
class DashboardStatGrid extends StatelessWidget {
  final List<DashboardStatCard> cards;
  const DashboardStatGrid({super.key, required this.cards});

  @override
  Widget build(BuildContext context) {
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: AppSpacing.sm,
      crossAxisSpacing: AppSpacing.sm,
      childAspectRatio: 2.4,
      children: cards,
    );
  }
}

/// Section title used above each KPI grid/card group.
class DashboardSectionHeader extends StatelessWidget {
  final String title;
  const DashboardSectionHeader(this.title, {super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      child: Text(
        title,
        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: AppColors.primary),
      ),
    );
  }
}

/// A documented-gap card (brief: "Visits Planned" / "Customer Location" have
/// no backing data yet) -- explicit and labeled rather than silently omitted
/// or guessed at.
class DashboardGapCard extends StatelessWidget {
  final String title;
  final String reason;
  const DashboardGapCard({super.key, required this.title, required this.reason});

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minHeight: AppDimens.listRow),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.neutralContainer,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline, size: 18, color: AppColors.textSecondary),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                const SizedBox(height: 2),
                Text(reason, style: const TextStyle(fontSize: 14, color: AppColors.textSecondary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
