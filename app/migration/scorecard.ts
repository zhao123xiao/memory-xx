import {
  ShadowDiffCategory,
  ShadowDiffSeverity,
  type ShadowCaseResult,
  type ShadowScorecard
} from "./types";

function severityRank(severity: ShadowDiffSeverity): number {
  switch (severity) {
    case ShadowDiffSeverity.Info:
      return 0;
    case ShadowDiffSeverity.Warning:
      return 1;
    case ShadowDiffSeverity.Critical:
      return 2;
  }
}

export function maxShadowSeverity(
  severities: readonly ShadowDiffSeverity[]
): ShadowDiffSeverity {
  return severities.reduce<ShadowDiffSeverity>(
    (highest, current) =>
      severityRank(current) > severityRank(highest) ? current : highest,
    ShadowDiffSeverity.Info
  );
}

export function createShadowScorecard(
  cases: readonly ShadowCaseResult[]
): ShadowScorecard {
  const diffCounts = Object.fromEntries(
    Object.values(ShadowDiffCategory).map((category) => [category, 0])
  ) as Record<ShadowDiffCategory, number>;
  const severityCounts = Object.fromEntries(
    Object.values(ShadowDiffSeverity).map((severity) => [severity, 0])
  ) as Record<ShadowDiffSeverity, number>;

  for (const item of cases) {
    severityCounts[item.severity] += 1;
    for (const diff of item.diffs) {
      diffCounts[diff.category] += 1;
    }
  }

  const passedCases = cases.filter((item) => item.passed).length;
  const failedCases = cases.length - passedCases;
  const highestSeverity = maxShadowSeverity(cases.map((item) => item.severity));

  return {
    totalCases: cases.length,
    passedCases,
    failedCases,
    diffCounts,
    severityCounts,
    highestSeverity,
    rerunRecommended: highestSeverity !== ShadowDiffSeverity.Info,
    rerunStrategy:
      highestSeverity === ShadowDiffSeverity.Critical
        ? "block_and_rerun_after_fix"
        : highestSeverity === ShadowDiffSeverity.Warning
          ? "rerun_failed_cases_after_analysis"
          : "no_rerun_needed"
  };
}
