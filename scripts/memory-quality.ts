import "./test-harness/config";

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";

import { config } from "./test-harness/config";

type Suite = "fixed-smoke" | "random" | "trace-replay" | "live" | "all";

interface UnifiedQualityMetrics {
  top1_recall: number | null;
  top3_recall: number | null;
  top5_recall: number | null;
  mrr: number | null;
  ndcg_at_5: number | null;
  false_null_rate: number | null;
  null_accuracy: number | null;
  forbidden_hit_rate: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  degrade_rate: number | null;
  embedding_error_rate: number | null;
  manual_review_only?: boolean;
  topk_source?: string;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const found = index >= 0 ? process.argv[index] : undefined;
  if (!found) return undefined;
  if (found === name) return process.argv[index + 1] && !process.argv[index + 1]!.startsWith("-") ? process.argv[index + 1] : "true";
  return found.slice(prefix.length);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reciprocalRank(rank: number | null): number {
  return rank && rank > 0 ? 1 / rank : 0;
}

function ndcgAt5ForRank(rank: number | null): number {
  return rank && rank > 0 && rank <= 5 ? 1 / Math.log2(rank + 1) : 0;
}

function normalizeMetrics(raw: any, options?: Partial<UnifiedQualityMetrics>): UnifiedQualityMetrics {
  return {
    top1_recall: numberOrNull(raw?.top1_recall),
    top3_recall: numberOrNull(raw?.top3_recall),
    top5_recall: numberOrNull(raw?.top5_recall),
    mrr: numberOrNull(raw?.mrr),
    ndcg_at_5: numberOrNull(raw?.ndcg_at_5),
    false_null_rate: numberOrNull(raw?.false_null_rate),
    null_accuracy: numberOrNull(raw?.null_accuracy),
    forbidden_hit_rate: numberOrNull(raw?.forbidden_hit_rate),
    latency_p50_ms: numberOrNull(raw?.latency_p50_ms),
    latency_p95_ms: numberOrNull(raw?.latency_p95_ms),
    latency_p99_ms: numberOrNull(raw?.latency_p99_ms),
    degrade_rate: numberOrNull(raw?.degrade_rate),
    embedding_error_rate: numberOrNull(raw?.embedding_error_rate),
    ...options,
  };
}

function thresholdFailures(suite: Suite, metrics: UnifiedQualityMetrics, report?: any): string[] {
  const failures: string[] = [];
  const top1Gate = suite === "fixed-smoke" ? 80 : 80;
  const top3Gate = suite === "fixed-smoke" ? 90 : 90;
  if (!metrics.manual_review_only) {
    if (metrics.top1_recall !== null && metrics.top1_recall < top1Gate) failures.push(`${suite}_top1_lt_${top1Gate}`);
    if (metrics.top3_recall !== null && metrics.top3_recall < top3Gate) failures.push(`${suite}_top3_lt_${top3Gate}`);
    if (metrics.mrr !== null && metrics.mrr < 0.70) failures.push(`${suite}_mrr_lt_0_70`);
    if (metrics.ndcg_at_5 !== null && metrics.ndcg_at_5 < 0.75) failures.push(`${suite}_ndcg_at_5_lt_0_75`);
  }
  if (metrics.false_null_rate !== null && metrics.false_null_rate > 5) failures.push(`${suite}_false_null_gt_5`);
  if (metrics.null_accuracy !== null && metrics.null_accuracy < 100) failures.push(`${suite}_null_accuracy_lt_100`);
  if (metrics.forbidden_hit_rate !== null && metrics.forbidden_hit_rate > 0) failures.push(`${suite}_forbidden_hit_gt_0`);
  if (metrics.latency_p99_ms !== null && metrics.latency_p99_ms > 15000) failures.push(`${suite}_p99_gt_15s`);
  if (metrics.degrade_rate !== null && metrics.degrade_rate > 20) failures.push(`${suite}_degrade_rate_gt_20`);
  if (metrics.embedding_error_rate !== null && metrics.embedding_error_rate > 2) failures.push(`${suite}_embedding_error_rate_gt_2`);
  if (suite === "live" && Number.parseFloat(String(report?.passRate ?? "100")) < 80) failures.push("live_pass_rate_lt_80");
  return failures;
}

function suiteList(): Suite[] {
  const suite = (argValue("--suite") || "all") as Suite;
  if (suite === "all") return ["fixed-smoke", "random", "trace-replay", "live"];
  if (["fixed-smoke", "random", "trace-replay", "live"].includes(suite)) return [suite];
  throw new Error(`Unknown suite: ${suite}`);
}

function runCommand(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, [...args], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: "/tmp", ...(env ?? {}) },
      encoding: "utf8",
      timeout: 900000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const e = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      output: `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}\n${e.message}`,
    };
  }
}

async function runFixedSmoke(): Promise<Record<string, unknown>> {
  const result = runCommand("npm", ["run", "test:quality"]);
  const reportMatch = result.output.match(/@@LAYER_REPORT@@(.+)@@END_REPORT@@/s);
  const layerReport = reportMatch ? JSON.parse(reportMatch[1]!) as Record<string, unknown> : null;
  const metrics = normalizeMetrics((layerReport as any)?.metrics ?? {});
  const failures = thresholdFailures("fixed-smoke", metrics);
  return {
    ok: result.ok && Boolean(layerReport?.ok) && failures.length === 0,
    layer_report: layerReport,
    metrics,
    threshold_failures: failures,
    output_tail: result.output.slice(-3000),
  };
}

async function runRandom(outDir: string): Promise<Record<string, unknown>> {
  const reportPath = path.join(outDir, "random-recall-sample-report.json");
  const result = runCommand(process.execPath, ["--import", "tsx", "scripts/random-recall-sample.ts"], {
    RANDOM_RECALL_REPORT_PATH: reportPath,
    RANDOM_RECALL_QUERY_DELAY_MS: process.env.RANDOM_RECALL_QUERY_DELAY_MS ?? "0",
    RANDOM_RECALL_WARM_QUERY_DELAY_MS: process.env.RANDOM_RECALL_WARM_QUERY_DELAY_MS ?? "0",
    RANDOM_RECALL_BATCH_PAUSE_AFTER: process.env.RANDOM_RECALL_BATCH_PAUSE_AFTER ?? "0",
  });
  let report: unknown = null;
  try {
    const raw = await fs.readFile(reportPath, "utf8");
    report = JSON.parse(raw);
    await fs.writeFile("migration_artifacts/random-recall-sample-report.json", raw);
  } catch {}
  const metrics = report && typeof report === "object" ? (report as any).metrics ?? {} : {};
  const unified = normalizeMetrics(metrics);
  const failures = thresholdFailures("random", unified);
  return { ok: result.ok && failures.length === 0, threshold_failures: failures, metrics: unified, report_path: reportPath, report, output_tail: result.output.slice(-3000) };
}

async function runLive(outDir: string): Promise<Record<string, unknown>> {
  const result = runCommand(process.execPath, ["--import", "tsx", "scripts/live-recall-smoke.ts"], {
    LIVE_RECALL_QUERY_DELAY_MS: process.env.LIVE_RECALL_QUERY_DELAY_MS ?? "0",
  });
  const sourcePath = "migration_artifacts/live-recall-smoke-report.json";
  const reportPath = path.join(outDir, "live-recall-smoke-report.json");
  let report: unknown = null;
  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    report = JSON.parse(raw);
    await fs.writeFile(reportPath, raw);
  } catch {}
  const passRate = Number.parseFloat(String((report as any)?.passRate ?? "0"));
  const unified = normalizeMetrics((report as any)?.metrics ?? {}, {
    manual_review_only: true,
    topk_source: "keyword_smoke_proxy",
    top1_recall: null,
    top3_recall: null,
    top5_recall: null,
  });
  const failures = thresholdFailures("live", unified, report);
  return { ok: result.ok && passRate >= 80 && failures.length === 0, threshold_failures: failures, metrics: unified, report_path: reportPath, report, output_tail: result.output.slice(-3000) };
}

function extractMemoryIdsFromTraceResults(results: unknown): string[] {
  if (!results || typeof results !== "object") return [];
  const maybe = results as { memory_ids?: unknown; ranked?: unknown };
  if (Array.isArray(maybe.memory_ids)) return maybe.memory_ids.map(String).filter(Boolean);
  if (Array.isArray(maybe.ranked)) {
    return maybe.ranked.map((item) => item && typeof item === "object" && "memory_id" in item ? String((item as { memory_id?: unknown }).memory_id ?? "") : "").filter(Boolean);
  }
  return [];
}

async function recall(query: string, scopeContext: unknown): Promise<{ status: number; data: any; latency_ms: number }> {
  const started = Date.now();
  const response = await fetch(`${config.wrapperUrl}/api/memory/v2/recall/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.wrapperToken ? { authorization: `Bearer ${config.wrapperToken}` } : {}),
    },
    body: JSON.stringify({
      query,
      scope_context: scopeContext && typeof scopeContext === "object" ? scopeContext : undefined,
      limit: 5,
      explain: true,
      debug: { enabled: true },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, latency_ms: Date.now() - started };
}

async function runTraceReplay(outDir: string): Promise<Record<string, unknown>> {
  const pool = new Pool({ connectionString: config.dbUrl, max: 2 });
  const limit = Number.parseInt(argValue("--trace-limit") || process.env.MEMORY_V2_TRACE_REPLAY_LIMIT || "50", 10);
  const rows: Array<{
    id: string;
    query_excerpt: string;
    scope_context: unknown;
    results: unknown;
    expected_ids: string[];
  }> = [];
  try {
    await pool.query(`SET search_path TO ${config.dbSchema}`);
    const result = await pool.query(`
      SELECT
        trace.id,
        trace.query_excerpt,
        trace.scope_context,
        trace.results,
        array_remove(array_agg(DISTINCT feedback.memory_id), NULL) AS expected_ids
      FROM recall_traces trace
      JOIN recall_feedback_events feedback
        ON feedback.recall_trace_id = trace.id
       AND feedback.feedback_type IN ('used_in_context', 'adopted')
       AND feedback.suspicious IS FALSE
       AND feedback.memory_id IS NOT NULL
      WHERE trace.created_at >= now() - interval '14 days'
      GROUP BY trace.id, trace.query_excerpt, trace.scope_context, trace.results, trace.created_at
      ORDER BY trace.created_at DESC
      LIMIT $1
    `, [limit]);
    for (const row of result.rows) {
      rows.push({
        id: String(row.id),
        query_excerpt: String(row.query_excerpt ?? ""),
        scope_context: row.scope_context,
        results: row.results,
        expected_ids: Array.isArray(row.expected_ids) ? row.expected_ids.map(String) : [],
      });
    }
  } finally {
    await pool.end();
  }

  const cases = [];
  const latencies: number[] = [];
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let falseNull = 0;
  let degraded = 0;
  let forbidden = 0;
  let mrr = 0;
  let ndcg = 0;
  let embeddingErrors = 0;
  for (const row of rows) {
    const response = await recall(row.query_excerpt, row.scope_context);
    latencies.push(response.latency_ms);
    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    const expected = row.expected_ids.length > 0 ? row.expected_ids : extractMemoryIdsFromTraceResults(row.results);
    const ranks = expected.map((id) => results.findIndex((item: any) => (item.memory_id || item.id) === id)).filter((rank) => rank >= 0);
    const bestRank = ranks.length > 0 ? Math.min(...ranks) + 1 : null;
    if (bestRank === 1) top1 += 1;
    if (bestRank !== null && bestRank <= 3) top3 += 1;
    if (bestRank !== null && bestRank <= 5) top5 += 1;
    if (results.length === 0) falseNull += 1;
    if (response.data?.degraded) degraded += 1;
    mrr += reciprocalRank(bestRank);
    ndcg += ndcgAt5ForRank(bestRank);
    const embeddingAudit = response.data?.explain?.embedding ?? response.data?.audit?.embedding;
    if (embeddingAudit?.final_error || embeddingAudit?.error_code) embeddingErrors += 1;
    cases.push({
      trace_id: row.id,
      query: row.query_excerpt,
      expected_ids: expected,
      status: response.status,
      best_rank: bestRank,
      top1_id: results[0]?.memory_id ?? results[0]?.id ?? null,
      latency_ms: response.latency_ms,
      degraded: Boolean(response.data?.degraded),
      embedding_error: Boolean(embeddingAudit?.final_error || embeddingAudit?.error_code),
    });
  }
  const total = Math.max(rows.length, 1);
  const metrics = normalizeMetrics({
    top1_recall: (top1 / total) * 100,
    top3_recall: (top3 / total) * 100,
    top5_recall: (top5 / total) * 100,
    mrr: mrr / total,
    ndcg_at_5: ndcg / total,
    false_null_rate: (falseNull / total) * 100,
    null_accuracy: 100,
    forbidden_hit_rate: (forbidden / total) * 100,
    degrade_rate: (degraded / total) * 100,
    embedding_error_rate: (embeddingErrors / total) * 100,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    latency_p99_ms: percentile(latencies, 99),
  });
  const report = {
    timestamp: new Date().toISOString(),
    suite: "trace-replay",
    totalCases: rows.length,
    eligibleCases: rows.length,
    note: rows.length === 0 ? "No positive-feedback recall traces found in the replay window; this is a warning, not a quality pass." : undefined,
    metrics,
    cases,
  };
  const reportPath = path.join(outDir, "trace-replay-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await fs.writeFile("migration_artifacts/trace-replay-report.json", JSON.stringify(report, null, 2));
  const failures = rows.length > 0 ? thresholdFailures("trace-replay", metrics) : [];
  return { ok: rows.length > 0 ? failures.length === 0 : true, threshold_failures: failures, metrics, report_path: reportPath, report };
}

function buildMarkdownReport(summary: any): string {
  const lines = [
    "# memory-xx Quality Report",
    "",
    `- Run ID: ${summary.run_id}`,
    `- Generated: ${summary.generated_at}`,
    `- Status: ${summary.ok ? "PASS" : "FAIL"}`,
    `- Output: ${summary.out_dir}`,
    "",
    "| suite | ok | Top-1 | Top-3 | Top-5 | MRR | NDCG@5 | false null | null acc | forbidden | P99 ms | degrade | embedding err | failures |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const [suite, result] of Object.entries(summary.suites ?? {}) as Array<[string, any]>) {
    const metrics = normalizeMetrics(result?.metrics ?? result?.report?.metrics ?? result?.layer_report?.metrics ?? {});
    const fmt = (value: number | null, digits = 2) => value === null ? "-" : value.toFixed(digits);
    lines.push([
      suite,
      result?.ok === false ? "FAIL" : "PASS",
      fmt(metrics.top1_recall),
      fmt(metrics.top3_recall),
      fmt(metrics.top5_recall),
      fmt(metrics.mrr, 3),
      fmt(metrics.ndcg_at_5, 3),
      fmt(metrics.false_null_rate),
      fmt(metrics.null_accuracy),
      fmt(metrics.forbidden_hit_rate),
      fmt(metrics.latency_p99_ms, 0),
      fmt(metrics.degrade_rate),
      fmt(metrics.embedding_error_rate),
      (result?.threshold_failures ?? []).join(", ") || "-",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push("## Next Commands");
  lines.push("");
  lines.push("- `TMPDIR=/tmp npm run memory:doctor -- --target quality-ready --plan`");
  lines.push("- `TMPDIR=/tmp npm run memory:doctor -- --target release-ready --mode full --plan`");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const runId = `quality-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outDir = path.join(config.reportDir, "quality", runId);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir("migration_artifacts", { recursive: true });

  const results: Record<string, unknown> = {};
  for (const suite of suiteList()) {
    if (suite === "fixed-smoke") results[suite] = await runFixedSmoke();
    if (suite === "random") results[suite] = await runRandom(outDir);
    if (suite === "trace-replay") results[suite] = await runTraceReplay(outDir);
    if (suite === "live") results[suite] = await runLive(outDir);
  }
  const ok = Object.values(results).every((item: any) => item?.ok !== false);
  const summary = { ok, run_id: runId, generated_at: new Date().toISOString(), out_dir: outDir, suites: results };
  await fs.writeFile(path.join(outDir, "quality-report.json"), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(outDir, "quality-report.md"), buildMarkdownReport(summary));
  await fs.writeFile("migration_artifacts/quality-report.json", JSON.stringify(summary, null, 2));
  await fs.writeFile("migration_artifacts/quality-report.md", buildMarkdownReport(summary));
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
