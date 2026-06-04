import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

interface EnvMap {
  readonly [key: string]: string | undefined;
}

interface MatrixCell {
  readonly concurrency: number;
  readonly interval_ms: number;
  readonly requests: number;
}

interface ProbeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly latency_ms: number;
  readonly error?: string;
}

interface CellReport extends MatrixCell {
  readonly attempted: number;
  readonly success: number;
  readonly status_429: number;
  readonly status_503: number;
  readonly failed: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly throughput_rps: number;
  readonly effective_rps: number;
  readonly stopped_early: boolean;
  readonly errors: Record<string, number>;
}

function readEnvFile(filePath: string): EnvMap {
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    const parsed: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      parsed[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return parsed;
  } catch {
    return {};
  }
}

const envFile = readEnvFile(process.env.MEMORY_XX_ENV_PATH || path.join(process.cwd(), ".env"));
function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || envFile[name]?.trim() || fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueQuery(runId: string, cell: MatrixCell, index: number): string {
  return [
    "memory-xx embedding calibration",
    runId,
    `c${cell.concurrency}`,
    `i${cell.interval_ms}`,
    `n${index}`,
    Date.now().toString(36),
  ].join(" ");
}

async function probeEmbedding(input: {
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dims: number;
  readonly query: string;
  readonly timeoutMs: number;
}): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        input: [input.query],
        dimensions: input.dims,
      }),
      signal: controller.signal,
    });
    await response.text();
    return {
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCell(input: {
  readonly cell: MatrixCell;
  readonly runId: string;
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dims: number;
  readonly timeoutMs: number;
  readonly cooldownMs: number;
}): Promise<CellReport> {
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  let success = 0;
  let status429 = 0;
  let status503 = 0;
  let consecutiveLimited = 0;
  let stoppedEarly = false;
  let launched = 0;
  const started = Date.now();
  const active = new Set<Promise<void>>();

  async function launch(index: number): Promise<void> {
    const result = await probeEmbedding({
      url: input.url,
      apiKey: input.apiKey,
      model: input.model,
      dims: input.dims,
      query: uniqueQuery(input.runId, input.cell, index),
      timeoutMs: input.timeoutMs,
    });
    latencies.push(result.latency_ms);
    if (result.ok) {
      success += 1;
      consecutiveLimited = 0;
      return;
    }
    if (result.status === 429) {
      status429 += 1;
      consecutiveLimited += 1;
    } else if (result.status === 503) {
      status503 += 1;
      consecutiveLimited += 1;
    } else {
      consecutiveLimited = 0;
    }
    const key = result.status > 0 ? `HTTP_${result.status}` : result.error ?? "request_failed";
    errors[key] = (errors[key] ?? 0) + 1;
  }

  while (launched < input.cell.requests) {
    if (consecutiveLimited >= 2) {
      stoppedEarly = true;
      break;
    }
    while (active.size >= input.cell.concurrency) {
      await Promise.race(active);
    }
    launched += 1;
    const task = launch(launched).finally(() => active.delete(task));
    active.add(task);
    await sleep(input.cell.interval_ms);
  }
  await Promise.all(active);
  if (stoppedEarly) {
    await sleep(input.cooldownMs);
  }

  const elapsedSeconds = Math.max(0.001, (Date.now() - started) / 1000);
  const attempted = latencies.length;
  return {
    ...input.cell,
    attempted,
    success,
    status_429: status429,
    status_503: status503,
    failed: attempted - success,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    throughput_rps: attempted / elapsedSeconds,
    effective_rps: success / elapsedSeconds,
    stopped_early: stoppedEarly,
    errors,
  };
}

function candidateMatrix(): MatrixCell[] {
  const requests = intEnv("EMBEDDING_CALIBRATION_REQUESTS_PER_CELL", 8);
  const phaseA = [500, 750, 1000, 1500, 2000].map((interval) => ({
    concurrency: 1,
    interval_ms: interval,
    requests,
  }));
  const phaseB = [1000, 1500, 2000].map((interval) => ({
    concurrency: 2,
    interval_ms: interval,
    requests,
  }));
  return [...phaseA, ...phaseB];
}

function recommend(cells: readonly CellReport[]): Record<string, unknown> {
  const stable = cells.filter((cell) =>
    cell.attempted === cell.requests &&
    cell.status_429 === 0 &&
    cell.status_503 === 0 &&
    cell.failed === 0
  );
  const selected = stable.sort((left, right) =>
    right.effective_rps - left.effective_rps ||
    left.p95_ms - right.p95_ms ||
    left.interval_ms - right.interval_ms
  )[0] ?? cells
    .filter((cell) => cell.status_429 === 0 && cell.status_503 === 0)
    .sort((left, right) => left.failed - right.failed || right.effective_rps - left.effective_rps)[0] ??
    cells.sort((left, right) => left.status_429 + left.status_503 - (right.status_429 + right.status_503))[0];

  return {
    selected: selected ? {
      concurrency: selected.concurrency,
      interval_ms: selected.interval_ms,
      p95_ms: selected.p95_ms,
      effective_rps: Number(selected.effective_rps.toFixed(3)),
    } : null,
    env: selected ? {
      EMBEDDING_PROXY_MAX_CONCURRENCY: String(selected.concurrency),
      EMBEDDING_PROXY_MIN_INTERVAL_MS: String(selected.interval_ms),
      EMBEDDING_PROXY_TIMEOUT_MS: "5000",
      EMBEDDING_PROXY_MAX_RETRIES: "0",
      EMBEDDING_PROXY_RATE_LIMIT_COOLDOWN_MS: "30000",
    } : {},
    policy: "stable-first: choose the fastest cell with zero 429/503/failures; keep interaction timeout short.",
  };
}

async function main(): Promise<void> {
  const apiKey = env("EMBEDDING_PROXY_UPSTREAM_API_KEY", env("OPENAI_API_KEY", env("EMBEDDING_API_KEY")));
  if (!apiKey) throw new Error("OPENAI_API_KEY or EMBEDDING_PROXY_UPSTREAM_API_KEY is required");
  const base = env("EMBEDDING_PROXY_UPSTREAM_BASE", env("EMBEDDING_API_BASE", "https://api.scnet.cn/api/llm/v1")).replace(/\/+$/u, "");
  const url = `${base}/embeddings`;
  const model = env("EMBEDDING_MODEL", "Qwen3-Embedding-8B");
  const dims = intEnv("EMBEDDING_DIMS", 4096);
  const timeoutMs = intEnv("EMBEDDING_CALIBRATION_TIMEOUT_MS", 7000);
  const cooldownMs = intEnv("EMBEDDING_CALIBRATION_COOLDOWN_MS", 15000);
  const reportRoot = env("MEMORY_XX_REPORT_DIR", path.join(process.cwd(), "reports/memory-xx-tests"));
  const runId = `embedding-calibration-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = path.join(reportRoot, "embedding-calibration", runId);
  await fs.mkdir(outputDir, { recursive: true });

  const reports: CellReport[] = [];
  for (const cell of candidateMatrix()) {
    if (cell.concurrency > 1 && reports.some((report) => report.concurrency === 1 && report.status_429 + report.status_503 > 0)) {
      break;
    }
    const report = await runCell({ cell, runId, url, apiKey, model, dims, timeoutMs, cooldownMs });
    reports.push(report);
    console.log(`cell c=${cell.concurrency} interval=${cell.interval_ms}ms success=${report.success}/${report.attempted} 429=${report.status_429} 503=${report.status_503} p95=${report.p95_ms}ms`);
  }

  const recommendation = recommend(reports);
  const jsonPath = path.join(outputDir, "embedding-calibration.json");
  const mdPath = path.join(outputDir, "embedding-calibration.md");
  await fs.writeFile(jsonPath, JSON.stringify({
    run_id: runId,
    generated_at: new Date().toISOString(),
    upstream_base: base,
    model,
    dims,
    timeout_ms: timeoutMs,
    matrix: reports,
    recommendation,
  }, null, 2));
  const lines = [
    "# Embedding Calibration",
    "",
    `- Run: ${runId}`,
    `- Model: ${model}`,
    `- Upstream: ${base}`,
    "",
    "| concurrency | interval_ms | attempted | success | 429 | 503 | failed | p95_ms | effective_rps |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...reports.map((cell) => `| ${cell.concurrency} | ${cell.interval_ms} | ${cell.attempted} | ${cell.success} | ${cell.status_429} | ${cell.status_503} | ${cell.failed} | ${cell.p95_ms} | ${cell.effective_rps.toFixed(3)} |`),
    "",
    "## Recommendation",
    "",
    "```json",
    JSON.stringify(recommendation, null, 2),
    "```",
    "",
  ];
  await fs.writeFile(mdPath, lines.join("\n"));
  console.log(`Report: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
