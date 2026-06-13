#!/usr/bin/env tsx
import "./test-harness/config.js";

import { loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { createConfiguredRecallRuntime } from "../app/recall/postgres-runtime";
import { loadMemoryXXQdrantConfig } from "../app/recall/qdrant-config";
import { OpenAICompatibleEmbeddingProvider } from "../app/server/embedding-provider";
import type { RecallRequest } from "../app/recall/types";

type Policy = "adaptive" | "force_top1" | "always";

const POLICIES: readonly Policy[] = ["adaptive", "force_top1", "always"];

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function runPolicy(policy: Policy, request: RecallRequest, iterations: number): Promise<Record<string, unknown>> {
  const previous = process.env.MEMORY_XX_RERANKER_POLICY;
  process.env.MEMORY_XX_RERANKER_POLICY = policy;
  const runtime = createConfiguredRecallRuntime({
    config: loadMemoryXXPostgresConfig(),
    qdrant: loadMemoryXXQdrantConfig(),
    query_embedding_provider: new OpenAICompatibleEmbeddingProvider(),
    vector_column_name: "content_embedding",
  }).runtime;
  try {
    const latencies: number[] = [];
    let modelUsed = 0;
    let timeouts = 0;
    let fallbacks = 0;
    const top1: string[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = Date.now();
      const response = await runtime.orchestrator.execute({ ...request, explain: true, rerank: true, hybrid_mode: "model_rerank" });
      latencies.push(Date.now() - started);
      if (response.audit.rerank?.model_used) modelUsed += 1;
      if (response.audit.rerank?.reason === "model_timeout") timeouts += 1;
      if (response.audit.rerank?.backend !== "model") fallbacks += 1;
      top1.push(response.results[0]?.memory_id ?? "");
    }
    return {
      policy,
      iterations,
      model_used_rate: modelUsed / iterations,
      timeout_rate: timeouts / iterations,
      fallback_rate: fallbacks / iterations,
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      p99_ms: percentile(latencies, 99),
      top1,
    };
  } finally {
    await runtime.close();
    if (previous === undefined) delete process.env.MEMORY_XX_RERANKER_POLICY;
    else process.env.MEMORY_XX_RERANKER_POLICY = previous;
  }
}

async function main(): Promise<void> {
  const query = argValue("--query") || "memory-xx reranker force_top1 adaptive top1 修正";
  const scopeId = argValue("--project-id") || "memory-xx";
  const iterations = Math.max(1, Math.min(30, Number.parseInt(argValue("--iterations") || "5", 10)));
  const request: RecallRequest = {
    query,
    scope_context: {
      user_id: argValue("--user-id") || "current-instance-owner",
      workspace_id: argValue("--workspace-id") || "current-instance",
      project_ids: [scopeId],
      include_global: true,
    },
    limit: Math.max(2, Math.min(20, Number.parseInt(argValue("--limit") || "8", 10))),
    explain: true,
    rerank: true,
    hybrid_mode: "model_rerank",
  };
  const results = [];
  for (const policy of POLICIES) {
    results.push(await runPolicy(policy, request, iterations));
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    request,
    concurrency_note: "Run separate shell instances to compare service-level concurrency; local GPU parallelism should stay <=2.",
    results,
  }, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
