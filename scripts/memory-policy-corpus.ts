#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

import { config } from "./test-harness/config.js";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers.js";
import {
  buildLocalNegativeSamples,
  buildPolicyTrainingReport,
  buildPolicyTrainingRecommendations,
  evaluatePolicyCorpusUpdateFlow,
  evaluatePolicyCorpus,
  extractBenchmarkRecords,
  isSafePolicyCorpusZipEntry,
  normalizeBenchmarkRecord,
  padPolicyCorpusSamples,
  validatePolicyEvalScope,
  type PolicyCorpusRawRecord,
  type PolicyCorpusSample,
  type PolicyTrainingReportInput,
} from "../app/governance/policy-corpus";
import { quoteIdent } from "./lib/runtime-env";

const ROOT = process.cwd();
const CORPUS_DIR = join(ROOT, "data", "policy-corpus");
const RAW_DIR = join(CORPUS_DIR, "raw");
const NORMALIZED_DIR = join(CORPUS_DIR, "normalized");
const SOURCES_DIR = join(CORPUS_DIR, "sources");
const REPORT_DIR = join(ROOT, "reports", "policy-training");
const execFileAsync = promisify(execFile);

interface Args {
  readonly command: string;
  readonly dataset: string;
  readonly input: string;
  readonly runId: string;
  readonly limit: number;
  readonly json: boolean;
  readonly allPermissions: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? "report";
  const value = (name: string): string => {
    const prefix = `--${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    if (inline !== undefined) return inline;
    const index = argv.indexOf(`--${name}`);
    if (index >= 0) return argv[index + 1] ?? "";
    return "";
  };
  const limit = Number.parseInt(value("limit") || "10000", 10);
  return {
    command,
    dataset: value("dataset") || "mem0-benchmarks",
    input: value("input"),
    runId: value("run-id") || `policy-training-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100_000) : 10_000,
    json: argv.includes("--json"),
    allPermissions: argv.includes("--all-permissions"),
  };
}

function print(args: Args, payload: unknown): void {
  if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function compactEvalForCli(result: ReturnType<typeof evaluatePolicyCorpus>): ReturnType<typeof evaluatePolicyCorpus> & { readonly truncated_failures?: number } {
  const failureLimit = 25;
  const failures = [...result.false_positive_cases, ...result.false_negative_cases];
  return {
    ...result,
    false_positive_cases: result.false_positive_cases.slice(0, failureLimit),
    false_negative_cases: result.false_negative_cases.slice(0, Math.max(0, failureLimit - result.false_positive_cases.length)),
    ...(failures.length > failureLimit ? { truncated_failures: failures.length - failureLimit } : {}),
  };
}

async function ensureDirs(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(NORMALIZED_DIR, { recursive: true });
  await mkdir(SOURCES_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });
}

function seedRecord(dataset: string, index: number): Record<string, unknown> {
  const mode = index % 10;
  if (mode === 0) return { id: `${dataset}-${index}`, context: "User prefers concise Chinese architecture answers.", question: "What style?", answer: "concise Chinese answers" };
  if (mode === 1) return { id: `${dataset}-${index}`, context: "The project default model is dreamfield/DeepSeek-V4-Flash.", question: "Which model?", answer: "dreamfield/DeepSeek-V4-Flash" };
  if (mode === 2) return { id: `${dataset}-${index}`, memory: "The user's timezone changed from UTC to Asia/Shanghai.", prompt: "Which timezone now?", target: "Asia/Shanghai", ability: "knowledge_update" };
  if (mode === 3) return { id: `${dataset}-${index}`, context: "Do not remember this temporary bridge validation.", question: "Remember?", answer: "no" };
  if (mode === 4) return { id: `${dataset}-${index}`, context: "source=unknown candidate should be isolated.", source: "unknown" };
  if (mode === 5) return { id: `${dataset}-${index}`, context: "Auto approval canary marker and perf-1 hook 验收标识.", question: "test?", answer: "test sample" };
  if (mode === 6) return { id: `${dataset}-${index}`, context: "配置文件 model_provider = \"codexshare\" token=sk_test_placeholder <windows-drive>\\codex-home", question: "config?", answer: "sensitive config" };
  if (mode === 7) return { id: `${dataset}-${index}`, context: "用户报告模型连接失败，报错 stream disconnected before completion。", question: "issue?", answer: "model connection failure" };
  if (mode === 8) return { id: `${dataset}-${index}`, context: "The API endpoint changed from /v1/old to /v2/new.", question: "Which endpoint?", answer: "/v2/new", category: "knowledge_update" };
  return { id: `${dataset}-${index}`, context: "Unknown answer is not present in the conversation.", question: "What is the secret project?", answer: "unknown", category: "abstention" };
}

function datasetHintFromPath(path: string, fallback: string): string {
  const lower = path.toLowerCase();
  if (lower.includes("locomo")) return "locomo";
  if (lower.includes("longmemeval-v2")) return "longmemeval-v2";
  if (lower.includes("longmem")) return "longmemeval";
  if (lower.includes("beam")) return "beam";
  return fallback;
}

async function collectDataFiles(path: string): Promise<string[]> {
  const current = await stat(path).catch(() => null);
  if (!current) return [];
  if (current.isFile()) return [path];
  if (!current.isDirectory()) return [];
  const entries = await readdir(path);
  const nested = await Promise.all(entries.map((entry) => collectDataFiles(join(path, entry))));
  return nested.flat();
}

async function extractZipInput(input: string): Promise<string> {
  await ensureDirs();
  const entries = (await execFileAsync("unzip", ["-Z1", input], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })).stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const unsafe = entries.find((entry) => !isSafePolicyCorpusZipEntry(entry));
  if (unsafe) throw new Error(`unsafe zip entry rejected: ${unsafe}`);
  const target = join(SOURCES_DIR, "memory-benchmarks");
  const tempTarget = join(SOURCES_DIR, `memory-benchmarks-extract-${Date.now()}`);
  await rm(tempTarget, { recursive: true, force: true });
  await mkdir(tempTarget, { recursive: true });
  await execFileAsync("unzip", ["-q", input, "-d", tempTarget], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const extractedRoot = existsSync(join(tempTarget, "memory-benchmarks-main"))
    ? join(tempTarget, "memory-benchmarks-main")
    : join(tempTarget, "memory-benchmarks-master");
  if (!existsSync(extractedRoot)) throw new Error("memory-benchmarks zip root not found");
  await rm(target, { recursive: true, force: true });
  await rename(extractedRoot, target);
  await rm(tempTarget, { recursive: true, force: true });
  return target;
}

async function readInputRecords(input: string, limit: number, fallbackDataset: string): Promise<PolicyCorpusRawRecord[]> {
  if (!input) return [];
  const sourcePath = extname(input).toLowerCase() === ".zip" ? await extractZipInput(input) : input;
  const allPaths = await collectDataFiles(sourcePath);
  const isMemoryBenchmarksRepo = basename(sourcePath) === "memory-benchmarks" || allPaths.some((path) => path.includes("/memory-benchmarks-main/") || path.includes("/memory-benchmarks-master/"));
  const paths = isMemoryBenchmarksRepo
    ? allPaths.filter((path) => path.includes("/results/platform/") || path.includes("/results/oss/"))
    : allPaths;
  const records: PolicyCorpusRawRecord[] = [];
  for (const path of paths) {
    if (records.length >= limit) break;
    const ext = extname(path).toLowerCase();
    if (![".json", ".jsonl", ".ndjson"].includes(ext)) continue;
    const dataset = datasetHintFromPath(path, fallbackDataset);
    const raw = await readFile(path, "utf8");
    if (ext === ".json") {
      const parsed = JSON.parse(raw) as unknown;
      const extracted = extractBenchmarkRecords(parsed, dataset);
      for (const item of extracted.length > 0 ? extracted : [{ dataset, raw: parsed }]) {
        if (records.length >= limit) break;
        records.push(item);
      }
    } else {
      for (const line of raw.split(/\r?\n/u)) {
        if (records.length >= limit) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed) as unknown;
        const extracted = extractBenchmarkRecords(parsed, dataset);
        records.push(...(extracted.length > 0 ? extracted : [{ dataset, raw: parsed }]).slice(0, limit - records.length));
      }
    }
  }
  return records;
}

async function maybeFetchDefaultDataset(dataset: string): Promise<{ input: string; source: string } | null> {
  if (dataset !== "mem0-benchmarks") return null;
  const target = join(SOURCES_DIR, "memory-benchmarks");
  if (existsSync(target)) return { input: target, source: "local_clone" };
  try {
    await execFileAsync("git", ["clone", "--depth=1", "https://github.com/mem0ai/memory-benchmarks.git", target], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { input: target, source: "github:mem0ai/memory-benchmarks" };
  } catch {
    const zipPath = join(SOURCES_DIR, "memory-benchmarks.zip");
    try {
      await execFileAsync("curl", ["-L", "--fail", "https://github.com/mem0ai/memory-benchmarks/archive/refs/heads/main.zip", "-o", zipPath], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync("unzip", ["-q", zipPath, "-d", SOURCES_DIR], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      const unzipDir = existsSync(join(SOURCES_DIR, "memory-benchmarks-main"))
        ? join(SOURCES_DIR, "memory-benchmarks-main")
        : join(SOURCES_DIR, "memory-benchmarks-master");
      if (existsSync(unzipDir)) {
        await rm(target, { recursive: true, force: true });
        await rename(unzipDir, target);
        return { input: target, source: "github_zip:mem0ai/memory-benchmarks" };
      }
    } catch {
      return null;
    }
    return null;
  }
}

async function importCorpus(args: Args): Promise<void> {
  await ensureDirs();
  const fetched = args.input ? null : await maybeFetchDefaultDataset(args.dataset);
  const input = args.input || fetched?.input || "";
  const inputRecords = await readInputRecords(input, args.limit, args.dataset);
  if (args.input && inputRecords.length === 0) {
    throw new Error(`no benchmark records imported from explicit input: ${args.input}`);
  }
  const records: PolicyCorpusRawRecord[] = inputRecords.length > 0
    ? inputRecords
    : Array.from({ length: args.limit }, (_, index) => ({ dataset: args.dataset, raw: seedRecord(args.dataset, index) }));
  const byDataset = new Map<string, unknown[]>();
  for (const record of records.slice(0, args.limit)) {
    byDataset.set(record.dataset, [...(byDataset.get(record.dataset) ?? []), record.raw]);
  }
  for (const file of await rawFiles()) {
    await rm(file, { force: true });
  }
  const paths: string[] = [];
  for (const [dataset, rows] of byDataset.entries()) {
    const path = join(RAW_DIR, `${dataset}.jsonl`);
    await writeFile(path, rows.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    paths.push(path);
  }
  print(args, {
    ok: true,
    command: "import",
    dataset: args.dataset,
    imported: Math.min(records.length, args.limit),
    dataset_counts: Object.fromEntries([...byDataset.entries()].map(([dataset, rows]) => [dataset, rows.length])),
    source: args.input || fetched?.source || "built_in_seed_adapter",
    raw_paths: paths,
    progress_percent: Math.min(40, Math.max(25, Math.floor(Math.min(records.length, args.limit) / 10_000 * 15) + 25)),
  });
}

async function rawFiles(): Promise<string[]> {
  await ensureDirs();
  const files = await readdir(RAW_DIR).catch(() => []);
  return files.filter((file) => file.endsWith(".jsonl") || file.endsWith(".json")).map((file) => join(RAW_DIR, file));
}

async function loadRawRecords(limit = 100_000): Promise<Array<{ dataset: string; raw: unknown }>> {
  const loaded: Array<{ dataset: string; raw: unknown }> = [];
  for (const file of await rawFiles()) {
    const dataset = basename(file).replace(/\.(jsonl|json)$/u, "");
    const raw = await readFile(file, "utf8");
    if (file.endsWith(".json")) {
      const parsed = JSON.parse(raw) as unknown;
      const rows = extractBenchmarkRecords(parsed, dataset);
      for (const row of rows.length > 0 ? rows : [{ dataset, raw: parsed }]) {
        if (loaded.length >= limit) return loaded;
        loaded.push(row);
      }
    } else {
      for (const line of raw.split(/\r?\n/u)) {
        if (loaded.length >= limit) return loaded;
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed) as unknown;
        const rows = extractBenchmarkRecords(parsed, dataset);
        for (const row of rows.length > 0 ? rows : [{ dataset, raw: parsed }]) {
          if (loaded.length >= limit) return loaded;
          loaded.push(row);
        }
      }
    }
  }
  return loaded;
}

async function normalizeCorpus(args: Args): Promise<PolicyCorpusSample[]> {
  await ensureDirs();
  const raw = await loadRawRecords(args.limit);
  const samples = raw.map((item) => normalizeBenchmarkRecord(item.dataset, item.raw));
  const withLocal = [...samples, ...buildLocalNegativeSamples(args.runId)];
  const padded = padPolicyCorpusSamples(withLocal, args.runId, args.limit);
  const path = join(NORMALIZED_DIR, "policy-corpus.jsonl");
  await writeFile(path, padded.map((sample) => JSON.stringify(sample)).join("\n") + "\n", "utf8");
  print(args, {
    ok: true,
    command: "normalize",
    normalized: padded.length,
    benchmark_samples: samples.length,
    hard_negative_samples: Math.max(0, padded.length - withLocal.length),
    normalized_path: path,
    progress_percent: padded.length >= 10_000 ? 40 : 25 + Math.floor(padded.length / 10_000 * 15),
  });
  return padded;
}

async function loadNormalized(limit = 100_000): Promise<PolicyCorpusSample[]> {
  const path = join(NORMALIZED_DIR, "policy-corpus.jsonl");
  const raw = await readFile(path, "utf8");
  return raw.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => JSON.parse(line) as PolicyCorpusSample);
}

function uniqueQuestionCount(samples: readonly PolicyCorpusSample[]): number {
  const ids = new Set<string>();
  for (const sample of samples) {
    if (sample.dataset === "local-negative") continue;
    ids.add(`${sample.dataset}:${sample.sample_id}`);
  }
  return ids.size;
}

async function evalCorpus(args: Args): Promise<ReturnType<typeof evaluatePolicyCorpus>> {
  const samples = await loadNormalized(args.limit).catch(async () => normalizeCorpus(args));
  const result = evaluatePolicyCorpus(samples);
  const reportPath = join(REPORT_DIR, args.runId, "offline-eval.json");
  await mkdir(join(REPORT_DIR, args.runId), { recursive: true });
  await writeFile(reportPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  print(args, { ok: result.failed === 0, command: "eval", report_path: reportPath, ...compactEvalForCli(result) });
  return result;
}

function scopeId(runId: string): string {
  return runId.startsWith("memory-policy-eval-") ? runId : `memory-policy-eval-${runId}`;
}

async function writeTestScope(args: Args): Promise<void> {
  if (!args.allPermissions) throw new Error("write-test-scope requires --all-permissions to make the eval-only boundary explicit");
  const samples = await loadNormalized(args.limit);
  const evalScopeId = scopeId(args.runId);
  const scopeChecks = ["project", "user", "global"].map((scopeType) => validatePolicyEvalScope(scopeType, evalScopeId));
  const failed = scopeChecks.find((check) => !check.ok);
  if (failed) throw new Error(`unsafe eval scope: ${failed.reason}`);

  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  let written = 0;
  let rejected = 0;
  try {
    for (const sample of samples.slice(0, args.limit)) {
      const scopeType = sample.scope_profile;
      const requestId = `policy_corpus_${args.runId}_${sample.sample_id}`.slice(0, 240);
      const memoryId = `memory_record_policy_corpus_${randomUUID()}`;
      const lifecycleStatus = sample.expected_policy_action === "create_memory" ? "approved" : "rejected";
      const reviewState = sample.expected_policy_action === "create_memory" ? "silent_approved" : "rejected";
      const isCurrent = lifecycleStatus === "approved";
      const metadata = {
        eval_only: true,
        policy_training: true,
        run_id: args.runId,
        dataset: sample.dataset,
        sample_id: sample.sample_id,
        expected_memory_class: sample.expected_memory_class,
        expected_policy_action: sample.expected_policy_action,
        expected_recall_policy: sample.expected_recall_policy,
        expected_lifecycle_intent: sample.expected_lifecycle_intent,
        expected_update_action: sample.expected_update_action,
        expected_answerable: sample.expected_answerable,
        risk_tags: sample.risk_tags,
        recall_policy: "test_only",
        memory_class: sample.expected_memory_class,
        policy_action: sample.expected_policy_action,
      };
      await query(pool,
        `INSERT INTO ${schema}.ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, completed_at, result_json)
         VALUES ($1, 'memory.create', $2, $3::jsonb, 'memory:policy-corpus', 'completed', now(), '{}'::jsonb)
         ON CONFLICT (request_id) DO NOTHING`,
        [requestId, sample.sample_id, JSON.stringify({ policy_corpus_sample: sample.sample_id })],
      );
      await query(pool,
        `INSERT INTO ${schema}.memory_records (
           id, request_id, scope_type, scope_id, content, title, summary, metadata, dedupe_key,
           lifecycle_status, review_state, is_current, version, created_by, updated_by, created_at, updated_at,
           agent_id, memory_type, valid_at, observed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, 1,
                 'memory:policy-corpus', 'memory:policy-corpus', now(), now(), 'policy-corpus', $13, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [
          memoryId,
          requestId,
          scopeType,
          evalScopeId,
          sample.candidate_memory,
          `policy-corpus:${sample.dataset}:${sample.sample_id}`.slice(0, 240),
          sample.evidence_span.slice(0, 500),
          JSON.stringify(metadata),
          `policy-corpus:${args.runId}:${sample.sample_id}`.slice(0, 240),
          lifecycleStatus,
          reviewState,
          isCurrent,
          sample.expected_memory_class === "preference" ? "preference" : sample.expected_memory_class === "constraint" ? "constraint" : "fact",
        ],
      );
      written += 1;
      if (lifecycleStatus === "rejected") rejected += 1;
    }
    const result = {
      ok: true,
      command: "write-test-scope",
      run_id: args.runId,
      progress_percent: 80,
      written,
      rejected,
      scopes: [`project:${evalScopeId}`, `user:${evalScopeId}`, `global:${evalScopeId}`],
    };
    await writeRunSummary(args.runId, { test_scope_write_eval: result });
    print(args, result);
  } finally {
    await closePool(pool);
  }
}

async function recallEval(args: Args): Promise<void> {
  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  const evalScopeId = scopeId(args.runId);
  try {
    const result = await query(pool,
      `SELECT count(*)::int AS checked,
              count(*) FILTER (
                WHERE metadata->>'eval_only' = 'true'
                  AND COALESCE(metadata->>'recall_policy', 'default') IN ('test_only', 'explicit_only', 'audit_only', 'never')
              )::int AS isolated,
              count(*) FILTER (
                WHERE metadata->>'eval_only' = 'true'
                  AND COALESCE(metadata->>'recall_policy', 'default') = 'default'
              )::int AS default_leakage
         FROM ${schema}.memory_records
        WHERE scope_id = $1
          AND metadata->>'policy_training' = 'true'`,
      [evalScopeId],
    );
    const row = result.rows[0] ?? {};
    const payload = {
      ok: Number(row.default_leakage ?? 0) === 0,
      command: "recall-eval",
      run_id: args.runId,
      progress_percent: 80,
      checked: Number(row.checked ?? 0),
      isolated: Number(row.isolated ?? 0),
      default_leakage: Number(row.default_leakage ?? 0),
    };
    await writeRunSummary(args.runId, { recall_eval: payload });
    print(args, payload);
  } finally {
    await closePool(pool);
  }
}

async function updateEval(args: Args): Promise<void> {
  const samples = await loadNormalized(args.limit);
  const expected = evaluatePolicyCorpusUpdateFlow(samples);
  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  const evalScopeId = scopeId(args.runId);
  try {
    const result = await query(pool,
      `UPDATE ${schema}.memory_records
          SET metadata = metadata || jsonb_build_object(
                'policy_corpus_update_eval',
                jsonb_build_object(
                  'evaluated_at', now(),
                  'expected_update_action', metadata->>'expected_update_action',
                  'run_id', $1::text
                )
              ),
              updated_by = 'memory:policy-corpus-update-eval',
              updated_at = now()
        WHERE scope_id = $2
          AND metadata->>'policy_training' = 'true'
          AND metadata->>'eval_only' = 'true'
          AND COALESCE(metadata->>'expected_update_action', 'none') <> 'none'
        RETURNING id`,
      [args.runId, evalScopeId],
    );
    const payload = {
      ok: expected.knowledge_update_accuracy >= 0.9,
      command: "update-eval",
      run_id: args.runId,
      progress_percent: 80,
      mutated: result.rowCount ?? result.rows.length,
      ...expected,
    };
    await writeRunSummary(args.runId, { update_eval: payload });
    print(args, payload);
  } finally {
    await closePool(pool);
  }
}

async function cleanup(args: Args): Promise<void> {
  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  const evalScopeId = scopeId(args.runId);
  try {
    const result = await query(pool,
      `UPDATE ${schema}.memory_records
          SET lifecycle_status = CASE WHEN lifecycle_status = 'approved' THEN 'archived' ELSE lifecycle_status END,
              is_current = false,
              updated_by = 'memory:policy-corpus-cleanup',
              updated_at = now(),
              invalid_at = COALESCE(invalid_at, now()),
              metadata = metadata || $2::jsonb
        WHERE scope_id = $1
          AND metadata->>'policy_training' = 'true'
          AND metadata->>'eval_only' = 'true'
        RETURNING id`,
      [evalScopeId, JSON.stringify({ policy_corpus_cleanup_at: new Date().toISOString() })],
    );
    print(args, { ok: true, command: "cleanup", run_id: args.runId, cleaned: result.rowCount ?? result.rows.length, progress_percent: 90 });
  } finally {
    await closePool(pool);
  }
}

async function writeRunSummary(runId: string, patch: Record<string, unknown>): Promise<void> {
  const dir = join(REPORT_DIR, runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "summary.json");
  const existing = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> : {};
  await writeFile(path, JSON.stringify({ ...existing, ...patch, run_id: runId, updated_at: new Date().toISOString() }, null, 2) + "\n", "utf8");
}

async function report(args: Args): Promise<void> {
  const normalized = await loadNormalized(args.limit).catch(() => []);
  const offline = normalized.length > 0 ? evaluatePolicyCorpus(normalized) : null;
  const updateFlow = normalized.length > 0 ? evaluatePolicyCorpusUpdateFlow(normalized) : null;
  const dir = join(REPORT_DIR, args.runId);
  const path = join(dir, "summary.json");
  const existing = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> : {};
  const recommendations = offline ? buildPolicyTrainingRecommendations(offline) : [];
  const summary = buildPolicyTrainingReport({
    runId: args.runId,
    importedCount: (await loadRawRecords(args.limit).catch(() => [])).length,
    normalizedCount: normalized.length,
    uniqueQuestionCount: uniqueQuestionCount(normalized),
    offlineEval: offline ? { total: offline.total, production_readiness_score: offline.production_readiness_score } : null,
    testScopeWrite: existing.test_scope_write_eval as PolicyTrainingReportInput["testScopeWrite"] ?? null,
    recallEval: existing.recall_eval as PolicyTrainingReportInput["recallEval"] ?? null,
    updateEval: existing.update_eval as PolicyTrainingReportInput["updateEval"] ?? updateFlow,
    recommendedPolicyChanges: recommendations,
    recommendationsCount: offline && offline.failed > 0 ? 1 : 0,
  });
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(summary, null, 2) + "\n", "utf8");
  print(args, { ok: true, command: "report", report_path: path, ...summary });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "import") return importCorpus(args);
  if (args.command === "normalize") {
    await normalizeCorpus(args);
    return;
  }
  if (args.command === "eval") {
    await evalCorpus(args);
    return;
  }
  if (args.command === "write-test-scope") return writeTestScope(args);
  if (args.command === "recall-eval") return recallEval(args);
  if (args.command === "update-eval") return updateEval(args);
  if (args.command === "cleanup") return cleanup(args);
  if (args.command === "report") return report(args);
  throw new Error(`unknown command: ${args.command}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
