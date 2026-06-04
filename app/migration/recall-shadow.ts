import { isEffectiveRecallable } from "../shared";
import type { RecallRequest, RecallResponse, RecallResultItem } from "../recall";
import { createShadowScorecard, maxShadowSeverity } from "./scorecard";
import {
  MigrationAuditStatus,
  MigrationJobType,
  MigrationSourceSystem,
  MigrationStage,
  ShadowDiffCategory,
  ShadowDiffSeverity,
  type LegacyRecallRuntime,
  type MigrationAuditRepositoryPort,
  type RecallShadowCase,
  type RecallShadowCaseResult,
  type RecallShadowCompareResult,
  type RecallShadowMatchMode,
  type ShadowDiff
} from "./types";

function resultIds(response: RecallResponse): string[] {
  return response.results.map((item) => item.memory_id);
}

function findOutOfScope(
  response: RecallResponse,
  allowedKeys: Set<string>
): RecallResultItem[] {
  return response.results.filter(
    (item) => !allowedKeys.has(`${item.scope.type}:${item.scope.id}`)
  );
}

function findDefaultFilterViolations(response: RecallResponse): RecallResultItem[] {
  return response.results.filter(
    (item) =>
      !isEffectiveRecallable({
        lifecycleStatus:
          (item as unknown as { lifecycleStatus?: any }).lifecycleStatus ?? "approved",
        isCurrent: (item as unknown as { isCurrent?: boolean }).isCurrent ?? true,
        reviewState:
          (item as unknown as { reviewState?: any }).reviewState ?? "approved"
      })
  );
}

function compareRecallResultIds(input: {
  legacyIds: string[];
  candidateIds: string[];
  matchMode: RecallShadowMatchMode;
}): ShadowDiff | null {
  const { legacyIds, candidateIds, matchMode } = input;

  if (matchMode === "top1_must_match_allow_tail") {
    const legacyTop1 = legacyIds[0] ?? null;
    const candidateTop1 = candidateIds[0] ?? null;
    if (legacyTop1 === candidateTop1) {
      return null;
    }

    return {
      category: ShadowDiffCategory.ResultMismatch,
      severity:
        legacyIds.length === 0 && candidateIds.length > 0
          ? ShadowDiffSeverity.Info
          : ShadowDiffSeverity.Warning,
      code: "result_set_mismatch",
      summary: "candidate failed top1 match under top1_must_match_allow_tail policy",
      details: {
        match_mode: matchMode,
        legacy_result_ids: legacyIds,
        candidate_result_ids: candidateIds
      }
    };
  }

  const sameIds =
    legacyIds.length === candidateIds.length &&
    legacyIds.every((memoryId, index) => memoryId === candidateIds[index]);
  if (sameIds) {
    return null;
  }

  return {
    category: ShadowDiffCategory.ResultMismatch,
    severity:
      legacyIds.length === 0 && candidateIds.length > 0
        ? ShadowDiffSeverity.Info
        : ShadowDiffSeverity.Warning,
    code: "result_set_mismatch",
    summary: "legacy and candidate returned different ordered result ids",
    details: {
      match_mode: matchMode,
      legacy_result_ids: legacyIds,
      candidate_result_ids: candidateIds
    }
  };
}

function compareRecallCase(
  shadowCase: RecallShadowCase,
  candidate: RecallResponse
): RecallShadowCaseResult {
  const legacy = shadowCase.expectedLegacy;
  const legacyIds = resultIds(legacy);
  const candidateIds = resultIds(candidate);
  const diffs: ShadowDiff[] = [];

  const allowedKeys = new Set(
    candidate.allowed_scope_set.map((scope) => `${scope.type}:${scope.id}`)
  );
  const outOfScope = findOutOfScope(candidate, allowedKeys);
  if (outOfScope.length > 0) {
    diffs.push({
      category: ShadowDiffCategory.ScopeViolation,
      severity: ShadowDiffSeverity.Critical,
      code: "scope_violation",
      summary: `candidate returned ${outOfScope.length} out-of-scope results`,
      details: {
        memory_ids: outOfScope.map((item) => item.memory_id),
        allowed_scope_set: candidate.allowed_scope_set.map((item) => `${item.type}:${item.id}`)
      }
    });
  }

  if ((shadowCase.request.filter_mode ?? "default") === "default") {
    const violations = findDefaultFilterViolations(candidate);
    if (violations.length > 0) {
      diffs.push({
        category: ShadowDiffCategory.DefaultFilterViolation,
        severity: ShadowDiffSeverity.Critical,
        code: "default_filter_violation",
        summary: `candidate returned ${violations.length} non-effective-recallable results under default filter`,
        details: {
          memory_ids: violations.map((item) => item.memory_id)
        }
      });
    }
  }

  if (legacy.results.length > 0 && candidate.results.length === 0) {
    diffs.push({
      category: ShadowDiffCategory.ZeroHitRegression,
      severity: ShadowDiffSeverity.Critical,
      code: "zero_hit_regression",
      summary: "legacy had hits but candidate returned zero results",
      details: {
        legacy_result_ids: legacyIds,
        candidate_result_ids: candidateIds
      }
    });
  }

  if (!legacy.degraded && candidate.degraded) {
    diffs.push({
      category: ShadowDiffCategory.DegradeRegression,
      severity: ShadowDiffSeverity.Warning,
      code: "degrade_regression",
      summary: "candidate degraded while legacy did not",
      details: {
        legacy_degrade_reason: legacy.degrade_reason ?? null,
        candidate_degrade_reason: candidate.degrade_reason ?? null
      }
    });
  }

  const resultIdDiff = compareRecallResultIds({
    legacyIds,
    candidateIds,
    matchMode: shadowCase.matchMode ?? "exact_ordered_set"
  });
  if (resultIdDiff) {
    diffs.push(resultIdDiff);
  }

  return {
    caseId: shadowCase.caseId,
    legacy,
    candidate,
    diffs,
    severity: maxShadowSeverity(diffs.map((diff) => diff.severity)),
    passed: diffs.length === 0
  };
}

export interface RecallShadowHarnessOptions {
  readonly runId: string;
  readonly legacyRuntime: LegacyRecallRuntime;
  readonly candidateRuntime: LegacyRecallRuntime;
  readonly auditRepository: MigrationAuditRepositoryPort;
  readonly operator?: string;
  readonly workerId?: string;
}

export class RecallShadowCompareHarness {
  private readonly options: RecallShadowHarnessOptions;

  constructor(options: RecallShadowHarnessOptions) {
    this.options = options;
  }

  async run(cases: readonly RecallShadowCase[]): Promise<RecallShadowCompareResult> {
    const results: RecallShadowCaseResult[] = [];

    for (const shadowCase of cases) {
      const startedAt = new Date().toISOString();
      const candidate = await this.options.candidateRuntime.execute(shadowCase.request);
      const result = compareRecallCase(shadowCase, candidate);
      results.push(result);

      await this.options.auditRepository.append({
        migrationRunId: this.options.runId,
        batchId: shadowCase.caseId,
        stage: MigrationStage.M3,
        jobType: MigrationJobType.ShadowCompare,
        sourceSystem: MigrationSourceSystem.MemoryXX,
        sourceLocator: `recall:${shadowCase.caseId}`,
        targetTableOrAsset: "recall.shadow_compare",
        targetRecordId: shadowCase.caseId,
        status:
          result.passed
            ? MigrationAuditStatus.Succeeded
            : result.severity === ShadowDiffSeverity.Critical
              ? MigrationAuditStatus.Failed
              : MigrationAuditStatus.SucceededWithDiff,
        diffSummary: result.diffs.map((diff) => diff.code).join(",") || undefined,
        rowCountExpected: shadowCase.expectedLegacy.results.length,
        rowCountLoaded: result.candidate.results.length,
        startedAt,
        operator: this.options.operator,
        workerId: this.options.workerId,
        metadata: {
          match_mode: shadowCase.matchMode ?? "exact_ordered_set",
          legacy: summarizeRecallResponse(shadowCase.expectedLegacy),
          candidate: summarizeRecallResponse(result.candidate),
          diffs: result.diffs.map((diff) => ({
            category: diff.category,
            severity: diff.severity,
            code: diff.code,
            summary: diff.summary,
            details: diff.details
          }))
        }
      });
    }

    return {
      runId: this.options.runId,
      cases: results,
      scorecard: createShadowScorecard(results)
    };
  }
}

function summarizeRecallResponse(response: RecallResponse) {
  return {
    results: response.results.map((item) => item.memory_id),
    degraded: response.degraded,
    degrade_reason: response.degrade_reason ?? null,
    returned_hits: response.audit.returned_hits,
    filter_mode_applied: response.filter_mode_applied
  };
}

export class StaticRecallRuntime implements LegacyRecallRuntime {
  constructor(private readonly responses: Readonly<Record<string, RecallResponse>>) {}

  async execute(request: RecallRequest): Promise<RecallResponse> {
    const key = JSON.stringify(request);
    const response = this.responses[key];
    if (!response) {
      throw new Error(`No static recall response registered for request ${key}`);
    }

    return response;
  }
}
