import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { createLogger } from "../../../app/shared/logger";

const log = createLogger("L13");
const runId = generateRunId();
const report = createEmptyReport("L13", runId);
const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + config.wrapperToken };
const testScopeId = `project-l13-${runId}`;
const knowledgeNeedle = `L13 knowledge markdown fixture ${runId}`;
let knowledgeCollectionId = "";
let memoryId = "";

async function post(path: string, body: Record<string, unknown>) {
  const resp = await fetch(config.wrapperUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: resp.status, data: await resp.json() };
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value)) throw new Error(`Unsafe schema identifier: ${value}`);
  return `"${value}"`;
}

function ingestMarkdownFixture(): { ok: boolean; collection: string; chunks: number; detail: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-xx-l13-"));
  const docPath = path.join(dir, "memory-xx-l13-runbook.md");
  writeFileSync(docPath, [
    "# memory-xx L13 runbook",
    "",
    `Current runbook knowledge: ${knowledgeNeedle}.`,
    "This runbook verifies knowledge ingest, Postgres fallback search, and unified hybrid recall source disambiguation.",
    "The operational keyword is qdrant pending memory knowledge recall current.",
    "",
  ].join("\n"), "utf8");

  const result = spawnSync("node", [
    "--import",
    "tsx",
    "scripts/knowledge/ingest-directory.ts",
    `--dir=${dir}`,
    `--scope-id=${testScopeId}`,
    `--token=${config.wrapperToken}`,
    `--run-id=${runId}`,
    "--max-files=5",
    "--max-bytes=20000",
  ], {
    cwd: config.projectRoot,
    env: { ...process.env, MEMORY_XX_DEFAULT_SCOPE_ID: testScopeId },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, collection: "", chunks: 0, detail: result.stderr.trim() || result.stdout.trim() || `exit=${result.status}` };
  }
  const output = JSON.parse(result.stdout) as any;
  const entries = Array.isArray(output.result?.manifest?.entries) ? output.result.manifest.entries : [];
  const imported = entries.find((entry: any) => entry.lifecycle === "import_current" && entry.collection);
  const chunks = Number(output.result?.ingest?.chunks ?? 0);
  return {
    ok: output.ok === true && chunks > 0 && Boolean(imported?.collection),
    collection: String(imported?.collection ?? ""),
    chunks,
    detail: `collection=${imported?.collection ?? "missing"}, chunks=${chunks}, dir=${dir}`,
  };
}

async function seedMemoryFixture(): Promise<void> {
  const written = await post("/api/memory/xx/write", {
    requestId: randomUUID(),
    actorId: "l13-knowledge-e2e",
    scopeType: "project",
    scopeId: testScopeId,
    content: `Memory counterpart for ${knowledgeNeedle}. This verifies unified recall returns memory and knowledge together.`,
    title: `L13 memory ${runId}`,
    memoryType: "fact",
    metadata: { source: "memory-xx-prod-test", run_id: runId },
  });
  memoryId = typeof written.data?.memoryId === "string" ? written.data.memoryId : "";
  if (!memoryId) {
    check("memory:seed-counterpart", false, `status=${written.status}, body=${JSON.stringify(written.data).slice(0, 160)}`);
    return;
  }
  const approved = await post(`/api/memory/xx/review/memories/${encodeURIComponent(memoryId)}/approve`, {
    requestId: randomUUID(),
    actorId: "l13-knowledge-e2e",
  });
  check("memory:seed-counterpart", approved.status === 200,
    `write_status=${written.status}, approve_status=${approved.status}, memoryId=${memoryId}`);
}

async function cleanup(): Promise<void> {
  report.cleanup.performed = true;
  if (memoryId) {
    try {
      const forgotten = await post("/api/memory/xx/orchestrator/forget-memory", {
        requestId: randomUUID(),
        actorId: "l13-knowledge-e2e-cleanup",
        memoryId,
        mode: "tombstone",
      });
      if (forgotten.status === 200) report.cleanup.resources_cleaned.push(`memory:${memoryId}`);
      else report.cleanup.failed.push(`memory:${memoryId}: status=${forgotten.status}`);
    } catch (error) {
      report.cleanup.failed.push(`memory:${memoryId}: ${(error as Error).message}`);
    }
  }

  const pool = createPool();
  const schema = quoteIdent("knowledge_v1");
  try {
    const chunkDelete = await query(pool, `DELETE FROM ${schema}.chunks WHERE metadata->>'ingest_run_id' = $1`, [runId]);
    const documentDelete = await query(pool, `DELETE FROM ${schema}.documents WHERE metadata->>'ingest_run_id' = $1`, [runId]);
    report.cleanup.resources_cleaned.push(`knowledge_chunks:${chunkDelete.rowCount ?? 0}`, `knowledge_documents:${documentDelete.rowCount ?? 0}`);
  } catch (error) {
    report.cleanup.failed.push(`knowledge:${(error as Error).message}`);
  } finally {
    await closePool(pool);
  }
  check("cleanup:fixtures", report.cleanup.failed.length === 0,
    `cleaned=${report.cleanup.resources_cleaned.length}, failed=${report.cleanup.failed.length}`,
    report.cleanup.failed.length === 0 ? "critical" : "warning");
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L13 Knowledge E2E — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    const ingested = ingestMarkdownFixture();
    knowledgeCollectionId = ingested.collection;
    check("knowledge:ingest-markdown-fixture", ingested.ok, ingested.detail);
    report.metrics["knowledge_fixture_chunks"] = ingested.chunks;
  } catch (error) {
    check("knowledge:ingest-markdown-fixture", false, (error as Error).message);
  }

  await seedMemoryFixture();

  try {
    const { status, data } = await post("/api/memory/xx/knowledge/search", {
      query: knowledgeNeedle,
      limit: 3,
      ...(knowledgeCollectionId ? { knowledge_collections: [knowledgeCollectionId] } : {}),
    });
    const first = data.results?.[0];
    const foundFixture = Array.isArray(data.results) && data.results.some((item: any) =>
      typeof item.content === "string" && item.content.includes(knowledgeNeedle)
    );
    check("knowledge:search", status === 200 && data.ok === true && foundFixture,
      `status=${status}, results=${data.results?.length ?? 0}, first=${first?.source_path ?? "none"}, collection=${knowledgeCollectionId || "unfiltered"}`);
  } catch (error) {
    check("knowledge:search", false, (error as Error).message);
  }

  try {
    const { status, data } = await post("/api/memory/xx/unified/recall", {
      query: knowledgeNeedle,
      scope_type: "project",
      scope_id: testScopeId,
      limit: 2,
      include_knowledge: true,
      knowledge_budget: 2,
      ...(knowledgeCollectionId ? { knowledge_collections: [knowledgeCollectionId] } : {}),
    });
    check("unified:recall-knowledge-opt-in", status === 200 && data.knowledge_included === true && data.knowledge_results?.length > 0,
      `status=${status}, memory=${data.results?.length ?? 0}, knowledge=${data.knowledge_results?.length ?? 0}`);
    const hybridResults = Array.isArray(data.hybrid_results) ? data.hybrid_results : [];
    const hasMemorySource = hybridResults.some((item: any) =>
      item.kind === "memory" && item.hybrid_rank_source === "memory" && item.source && item.memory_id === memoryId
    );
    const hasKnowledgeSource = hybridResults.some((item: any) =>
      item.kind === "knowledge" && item.hybrid_rank_source === "knowledge" && item.source?.source_path &&
        typeof item.content === "string" && item.content.includes(knowledgeNeedle)
    );
    check("unified:recall-source-disambiguation", status === 200 && hasMemorySource && hasKnowledgeSource,
      `status=${status}, hybrid=${hybridResults.length}, memory_source=${hasMemorySource}, knowledge_source=${hasKnowledgeSource}`);
  } catch (error) {
    check("unified:recall-knowledge-opt-in", false, (error as Error).message);
    check("unified:recall-source-disambiguation", false, (error as Error).message);
  }

  await cleanup();
  finalizeReport(report);
  log.info("Results", { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length, total: report.checks.length });
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  check("fatal", false, error instanceof Error ? error.message : String(error));
  cleanup()
    .catch((cleanupError) => {
      report.cleanup.failed.push(`cleanup:fatal:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    })
    .finally(() => {
      finalizeReport(report);
      console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
      process.exit(1);
    });
});
