import { promises as fs } from "node:fs";
import path from "node:path";

import {
  createPostgresRecallRuntime,
  FilterMode,
  InMemoryMigrationAuditRepository,
  RecallShadowCompareHarness,
  ScopeType,
  loadMemoryXXPostgresConfig,
  type RecallResponse,
  type RecallResultItem,
  type RecallScopeRef,
  type RecallShadowCase
} from "../app";

type NormalizedRecord = {
  record_id: string;
  title: string | null;
  content: string;
  summary: string | null;
};

async function loadRecords(batchDir: string): Promise<Map<string, NormalizedRecord>> {
  const file = path.join(batchDir, "normalized-records.jsonl");
  const lines = (await fs.readFile(file, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  const records = new Map<string, NormalizedRecord>();
  for (const line of lines) {
    const row = JSON.parse(line) as NormalizedRecord;
    records.set(row.record_id, row);
  }
  return records;
}

function buildLegacyResponse(input: {
  ids: string[];
  records: Map<string, NormalizedRecord>;
  allowedScopeSet: RecallScopeRef[];
  degraded?: boolean;
  degradeReason?: string;
}): RecallResponse {
  const results: RecallResultItem[] = input.ids.map((id) => {
    const record = input.records.get(id);
    return {
      memory_id: id,
      title: record?.title ?? id,
      content: record?.summary ?? record?.content ?? id,
      scope: input.allowedScopeSet[0] ?? { type: ScopeType.Workspace, id: "default" },
      score: 1,
      source_retrievers: ["legacy-frozen"],
      matched_terms: []
    };
  });

  return {
    results,
    filter_mode_applied: FilterMode.Default,
    allowed_scope_set: input.allowedScopeSet,
    degraded: input.degraded ?? true,
    degrade_reason: input.degradeReason ?? "legacy_lexical_only_frozen_baseline",
    audit_ref: `legacy:${input.ids.join(",") || "empty"}`,
    audit: {
      audit_ref: `legacy:${input.ids.join(",") || "empty"}`,
      query_type: "debug_recall" as any,
      strategy: "lexical_only" as any,
      degraded: input.degraded ?? true,
      degrade_reasons: [input.degradeReason ?? "legacy_lexical_only_frozen_baseline"],
      lexical_status: { name: "lexical", available: true },
      vector_status: { name: "vector", available: false, reason: input.degradeReason ?? "legacy_lexical_only_frozen_baseline" },
      lexical_hits: results.length,
      vector_hits: 0,
      merged_hits: results.length,
      returned_hits: results.length
    }
  };
}

async function main(): Promise<void> {
  const batchDirArg = process.argv[2];
  const outputDirArg = process.argv[3];
  if (!batchDirArg || !outputDirArg) {
    throw new Error("Usage: node --import tsx scripts/run-recall-shadow-r3.ts <batch-dir> <output-dir>");
  }

  const batchDir = path.resolve(process.cwd(), batchDirArg);
  const outputDir = path.resolve(process.cwd(), outputDirArg);
  await fs.mkdir(outputDir, { recursive: true });

  const records = await loadRecords(batchDir);
  const config = loadMemoryXXPostgresConfig(process.env);
  const runtime = createPostgresRecallRuntime({
    config,
    query_embedding_provider: {
      async embed_query() {
        return {
          embedding: [0.1, 0.2, 0.3],
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1
          }
        };
      }
    }
  });
  const auditRepository = new InMemoryMigrationAuditRepository();
  const runId = `recall-shadow-r3-${new Date().toISOString()}`;

  const cases: RecallShadowCase[] = [
    {
      caseId: "m3-user-confirm-external-send",
      request: {
        query: "对外发送 公开发布前必须先确认",
        scope_context: { user_id: "current-instance-owner" },
        filter_mode: FilterMode.Default,
        limit: 5,
        explain: true
      },
      expectedLegacy: buildLegacyResponse({
        ids: ["constraint_confirm_external_send"],
        records,
        allowedScopeSet: [{ type: ScopeType.User, id: "current-instance-owner" }]
      })
    },
    {
      caseId: "m3-workspace-ledger-source-of-truth",
      matchMode: "top1_must_match_allow_tail",
      request: {
        query: "Markdown 文件主账 唯一主账 SQLite 镜像",
        scope_context: { workspace_id: "memory-ledger" },
        filter_mode: FilterMode.Default,
        limit: 5,
        explain: true
      },
      expectedLegacy: buildLegacyResponse({
        ids: ["decision_markdown_source_of_truth"],
        records,
        allowedScopeSet: [{ type: ScopeType.Workspace, id: "memory-ledger" }]
      })
    },
    {
      caseId: "m3-project-tombstone-hidden",
      request: {
        query: "auth-profiles.json memorySearch 远端鉴权落点",
        scope_context: { project_ids: ["memory-system"] },
        filter_mode: FilterMode.Default,
        limit: 5,
        explain: true
      },
      expectedLegacy: buildLegacyResponse({
        ids: [],
        records,
        allowedScopeSet: [{ type: ScopeType.Project, id: "memory-system" }]
      })
    },
    {
      caseId: "m3-project-memory-system-status",
      request: {
        query: "排序质量 首条可用 混合样本覆盖",
        scope_context: { project_ids: ["memory-system"] },
        filter_mode: FilterMode.Default,
        limit: 5,
        explain: true
      },
      expectedLegacy: buildLegacyResponse({
        ids: [
          "03cd0aad1526249f32c45b538660c1275177e802",
          "project_p4_scorecard_phase_state",
          "286eb270ff5461c8b412fe1d9436d1d1ff2657e4",
          "154065bc79ed0eaa3e3716294802dbd676716d6f",
          "project_memory_system_status"
        ],
        records,
        allowedScopeSet: [{ type: ScopeType.Project, id: "memory-system" }]
      })
    },
    {
      caseId: "m3-workspace-semantic-mode-decision",
      request: {
        query: "semantic_mode 三态 skipped embedded degraded",
        scope_context: { workspace_id: "current-instance" },
        filter_mode: FilterMode.Default,
        limit: 5,
        explain: true
      },
      expectedLegacy: buildLegacyResponse({
        ids: ["decision_mem0_search_surfaces_semantic_mode"],
        records,
        allowedScopeSet: [{ type: ScopeType.Workspace, id: "current-instance" }]
      })
    },
    {
      caseId: "m3-workspace-project-scope-not-leak",
      request: {
        query: "排序质量 首条可用 混合样本覆盖",
        scope_context: { workspace_id: "memory-ledger" },
        filter_mode: FilterMode.Default,
        limit: 5,
        explain: true
      },
      expectedLegacy: buildLegacyResponse({
        ids: [],
        records,
        allowedScopeSet: [{ type: ScopeType.Workspace, id: "memory-ledger" }]
      })
    }
  ];

  try {
    const harness = new RecallShadowCompareHarness({
      runId,
      legacyRuntime: {
        async execute() {
          throw new Error("legacy runtime is frozen into expectedLegacy per case");
        }
      },
      candidateRuntime: {
        async execute(request) {
          return runtime.orchestrator.execute(request);
        }
      },
      auditRepository,
      operator: "klee",
      workerId: "recall-shadow-r3"
    });

    const result = await harness.run(cases);
    const output = {
      runId,
      schema: config.schema,
      batchDir,
      scorecard: result.scorecard,
      auditSummary: result.auditSummary,
      cases: result.cases.map((item) => ({
        caseId: item.caseId,
        passed: item.passed,
        severity: item.severity,
        matchMode: cases.find((shadowCase) => shadowCase.caseId === item.caseId)?.matchMode ?? "exact_ordered_set",
        legacyIds: item.legacy.results.map((row) => row.memory_id),
        candidateIds: item.candidate.results.map((row) => row.memory_id),
        degraded: item.candidate.degraded,
        degradeReason: item.candidate.degrade_reason ?? null,
        diffs: item.diffs
      }))
    };

    await fs.writeFile(
      path.join(outputDir, "m3-recall-shadow-report.json"),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8"
    );

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
