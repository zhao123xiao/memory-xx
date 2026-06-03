import assert from "node:assert/strict";
import test from "node:test";

import {
  FilterMode,
  InMemoryMigrationAuditRepository,
  LifecycleStatus,
  MigrationAuditStatus,
  MigrationShadowRuntimeChain,
  RecallShadowCompareHarness,
  ReviewState,
  ScopeType,
  ShadowDiffCategory,
  ShadowDiffSeverity,
  type RecallResponse,
  type RecallResultItem
} from "../app";

function createRecallResponse(input: {
  ids: string[];
  scopeId?: string;
  degraded?: boolean;
  degradeReason?: string;
  resultOverrides?: Partial<RecallResultItem & {
    lifecycleStatus: LifecycleStatus;
    isCurrent: boolean;
    reviewState: ReviewState;
  }>;
}): RecallResponse {
  const scopeId = input.scopeId ?? "p-alpha";
  const results = input.ids.map((id) => ({
    memory_id: id,
    title: id,
    content: `content:${id}`,
    scope: {
      type: ScopeType.Project,
      id: scopeId
    },
    score: 0.9,
    source_retrievers: ["lexical"],
    matched_terms: ["alpha"],
    ...input.resultOverrides
  }));

  return {
    results,
    filter_mode_applied: FilterMode.Default,
    allowed_scope_set: [{ type: ScopeType.Project, id: "p-alpha" }],
    degraded: input.degraded ?? false,
    degrade_reason: input.degradeReason,
    audit_ref: `audit:${input.ids.join(",") || "empty"}`,
    audit: {
      audit_ref: `audit:${input.ids.join(",") || "empty"}`,
      query_type: "project_context" as any,
      strategy: "hybrid" as any,
      degraded: input.degraded ?? false,
      degrade_reasons: input.degradeReason ? [input.degradeReason] : [],
      lexical_status: { name: "lexical", available: true },
      vector_status: {
        name: "vector",
        available: !(input.degraded ?? false),
        reason: input.degradeReason
      },
      lexical_hits: results.length,
      vector_hits: results.length,
      merged_hits: results.length,
      returned_hits: results.length
    }
  };
}

test("migration shadow runtime chain emits audit ledger and scorecard for recall diffs", async () => {
  const auditRepository = new InMemoryMigrationAuditRepository();
  const recallHarness = new RecallShadowCompareHarness({
    runId: "run-c6-shadow",
    legacyRuntime: {
      async execute() {
        throw new Error("legacy runtime is frozen into baseline cases for this harness");
      }
    },
    candidateRuntime: {
      async execute() {
        return createRecallResponse({
          ids: ["mem-hidden"],
          scopeId: "p-secret",
          degraded: true,
          degradeReason: "vector_backend_unavailable",
          resultOverrides: {
            lifecycleStatus: LifecycleStatus.Candidate,
            isCurrent: true,
            reviewState: ReviewState.Pending
          }
        }) as RecallResponse;
      }
    },
    auditRepository
  });

  const runtime = new MigrationShadowRuntimeChain({
    runId: "run-c6-shadow",
    auditRepository,
    recallHarness
  });

  const result = await runtime.run({
    recallCases: [
      {
        caseId: "recall-default-filter-and-scope",
        request: {
          query: "project alpha context",
          scope_context: { project_ids: ["p-alpha"] },
          filter_mode: FilterMode.Default
        },
        expectedLegacy: createRecallResponse({ ids: ["mem-ok"] })
      }
    ]
  });

  assert.equal(result.scorecard.totalCases, 1);
  assert.equal(result.scorecard.failedCases, 1);
  assert.equal(result.scorecard.highestSeverity, ShadowDiffSeverity.Critical);
  assert.equal(result.scorecard.diffCounts[ShadowDiffCategory.ScopeViolation], 1);
  assert.equal(result.scorecard.diffCounts[ShadowDiffCategory.DefaultFilterViolation], 1);
  assert.equal(result.scorecard.diffCounts[ShadowDiffCategory.ZeroHitRegression], 0);
  assert.equal(result.scorecard.diffCounts[ShadowDiffCategory.DegradeRegression], 1);
  assert.equal(result.scorecard.rerunStrategy, "block_and_rerun_after_fix");
  assert.equal(result.auditSummary.total, 1);
  assert.equal(result.auditSummary.byStatus[MigrationAuditStatus.Failed], 1);
});

test("recall shadow compare supports top1_must_match_allow_tail policy for curated workspace cases", async () => {
  const auditRepository = new InMemoryMigrationAuditRepository();
  const response = createRecallResponse({ ids: ["mem-primary", "mem-tail-1", "mem-tail-2"] });

  const recallHarness = new RecallShadowCompareHarness({
    runId: "run-top1-allow-tail",
    legacyRuntime: { async execute() { return response; } },
    candidateRuntime: { async execute() { return response; } },
    auditRepository
  });

  const result = await recallHarness.run([
    {
      caseId: "recall-top1-allow-tail",
      matchMode: "top1_must_match_allow_tail",
      request: {
        query: "source of truth",
        scope_context: { project_ids: ["p-alpha"] },
        filter_mode: FilterMode.Default
      },
      expectedLegacy: createRecallResponse({ ids: ["mem-primary"] })
    }
  ]);

  assert.equal(result.scorecard.failedCases, 0);
  assert.equal(result.cases[0]?.passed, true);
  assert.equal(result.cases[0]?.diffs.length, 0);
});

test("migration shadow runtime chain passes clean recall baselines", async () => {
  const auditRepository = new InMemoryMigrationAuditRepository();
  const request = {
    query: "alpha decision",
    scope_context: { project_ids: ["p-alpha"] },
    filter_mode: FilterMode.Default
  };
  const cleanResponse = createRecallResponse({ ids: ["mem-1"] });

  const recallHarness = new RecallShadowCompareHarness({
    runId: "run-clean",
    legacyRuntime: { async execute() { return cleanResponse; } },
    candidateRuntime: { async execute() { return cleanResponse; } },
    auditRepository
  });

  const runtime = new MigrationShadowRuntimeChain({
    runId: "run-clean",
    auditRepository,
    recallHarness
  });

  const result = await runtime.run({
    recallCases: [{ caseId: "recall-clean", request, expectedLegacy: cleanResponse }]
  });

  assert.equal(result.scorecard.failedCases, 0);
  assert.equal(result.scorecard.highestSeverity, ShadowDiffSeverity.Info);
  assert.equal(result.scorecard.rerunRecommended, false);
  assert.equal(result.auditSummary.byStatus[MigrationAuditStatus.Succeeded], 1);
});
