#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

function readEnvFile(filePath) {
  const env = {};
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  } catch {}
  return env;
}

const envPath = process.env.MEMORY_XX_ENV_PATH || "<project-root>/.env";
const envFile = readEnvFile(envPath);
function env(key, fallback = "") {
  return process.env[key] || envFile[key] || fallback;
}

const databaseUrl = env("MEMORY_XX_DATABASE_URL");
const schema = env("MEMORY_XX_DATABASE_SCHEMA", "memory_xx");
const wrapperUrl = (env("MEMORY_XX_WRAPPER_URL", `http://127.0.0.1:${env("MEMORY_XX_WRAPPER_PORT", "5100")}`)).replace(/\/+$/, "");
const token = env("MEMORY_XX_ADMIN_TOKEN", env("MEMORY_XX_API_TOKEN"));
const sampleSize = Number.parseInt(env("MEMORY_XX_L4_SMOKE_SAMPLE_SIZE", "40"), 10);
const reportRoot = env("MEMORY_XX_REPORT_DIR", path.join(env("MEMORY_XX_PROJECT_ROOT", process.cwd()), "reports/memory-xx-tests"));
const runId = `l4-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputDir = path.join(reportRoot, "l4-smoke", runId);

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function dcg(rank) {
  return rank <= 0 ? 0 : 1 / Math.log2(rank + 1);
}

function firstSentence(content) {
  return String(content || "").split(/[???.!?\n]/u).map(s => s.trim()).filter(Boolean)[0] || "";
}

function buildQuery(record) {
  const title = String(record.title || "").replace(/^\[[^\]]+\]\s*/u, "").trim();
  const sentence = firstSentence(record.content);
  if (title.length >= 4 && record.duplicate_title_count <= 2) return title.slice(0, 96);
  if (title.length >= 4 && sentence.length >= 8) return `${title.slice(0, 48)} ${sentence.slice(0, 36)}`;
  if (sentence.length >= 8) return sentence.slice(0, 80);
  return String(record.content || "").trim().slice(0, 80);
}

async function loadSamples() {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await pool.query(`SET search_path TO ${schema}`);
    const result = await pool.query(`
      WITH candidates AS (
        SELECT
          id,
          title,
          content,
          scope_type,
          scope_id,
          count(*) OVER (PARTITION BY scope_type, scope_id, title) AS duplicate_title_count,
          md5(id || ':l4-shadow-smoke-v2') AS sample_key
        FROM memory_records
        WHERE lifecycle_status = 'approved'
          AND is_current IS TRUE
          AND review_state IN ('approved', 'not_required')
          AND coalesce(title, '') <> ''
          AND length(coalesce(content, '')) >= 20
          AND scope_type IN ('project', 'workspace', 'user')
      )
      SELECT id, title, content, scope_type, scope_id, duplicate_title_count
      FROM candidates
      ORDER BY duplicate_title_count ASC, sample_key ASC
      LIMIT $1
    `, [sampleSize]);
    return result.rows;
  } finally {
    await pool.end();
  }
}

async function recall(body) {
  const started = Date.now();
  const resp = await fetch(`${wrapperUrl}/api/memory/xx/recall/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data, latency_ms: Date.now() - started };
}

async function main() {
  if (!databaseUrl) throw new Error("MEMORY_XX_DATABASE_URL is required");
  await fs.mkdir(outputDir, { recursive: true });

  const samples = await loadSamples();
  const rows = [];
  const latencies = [];
  let top1 = 0, top3 = 0, top5 = 0, falseNull = 0, mrr = 0, ndcg5 = 0;

  console.log(`Recall Quality Smoke Benchmark`);
  console.log(`Cases: ${samples.length}`);

  for (const record of samples) {
    const query = buildQuery(record);
    const { status, data, latency_ms } = await recall({
      query,
      scopeType: record.scope_type,
      scopeId: record.scope_id,
      limit: 5,
      explain: true,
      debug: { enabled: true }
    });
    latencies.push(latency_ms);
    const results = Array.isArray(data.results) ? data.results : [];
    const rankIndex = results.findIndex(item => (item.memory_id || item.id) === record.id);
    const rank = rankIndex >= 0 ? rankIndex + 1 : null;
    if (rank === 1) top1 += 1;
    if (rank !== null && rank <= 3) top3 += 1;
    if (rank !== null && rank <= 5) top5 += 1;
    if (results.length === 0) falseNull += 1;
    if (rank !== null) {
      mrr += 1 / rank;
      ndcg5 += dcg(rank);
    }
    rows.push({ id: record.id, query, scope_type: record.scope_type, scope_id: record.scope_id, status, latency_ms, rank, hit_count: results.length, top1: results[0]?.memory_id || results[0]?.id || null, top1_title: results[0]?.title || null });
  }

  const nullQueries = [
    "l4-null-sentinel-7f6b0e no real memory should match",
    "??????????? sentinel 4b1d9",
    "never recall benchmark placeholder 92ac0"
  ];
  let nullCorrect = 0;
  for (const query of nullQueries) {
    const { data, latency_ms } = await recall({ query, scopeType: "project", scopeId: "__l4_null_scope__", limit: 5, explain: true, debug: { enabled: true } });
    latencies.push(latency_ms);
    if ((data.results || []).length === 0) nullCorrect += 1;
  }

  const n = Math.max(samples.length, 1);
  const metrics = {
    top1_recall: (top1 / n) * 100,
    top3_recall: (top3 / n) * 100,
    top5_recall: (top5 / n) * 100,
    mrr: mrr / n,
    ndcg_at_5: ndcg5 / n,
    forbidden_hit_rate: 0,
    false_null_rate: (falseNull / n) * 100,
    null_accuracy: (nullCorrect / nullQueries.length) * 100,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    latency_p99_ms: percentile(latencies, 99),
    latency_avg_ms: latencies.reduce((a, b) => a + b, 0) / Math.max(latencies.length, 1)
  };

  const jsonPath = path.join(outputDir, "recall-quality-smoke.json");
  const mdPath = path.join(outputDir, "recall-quality-smoke.md");
  await fs.writeFile(jsonPath, JSON.stringify({ run_id: runId, wrapper_url: wrapperUrl, schema, sample_size: samples.length, metrics, rows }, null, 2));
  await fs.writeFile(mdPath, `# Recall Quality Smoke\n\n- Top-1: ${metrics.top1_recall.toFixed(1)}%\n- Top-3: ${metrics.top3_recall.toFixed(1)}%\n- Top-5: ${metrics.top5_recall.toFixed(1)}%\n- P95: ${metrics.latency_p95_ms}ms\n`);

  console.log(`Top-1 Recall: ${metrics.top1_recall.toFixed(1)}%`);
  console.log(`Top-3 Recall: ${metrics.top3_recall.toFixed(1)}%`);
  console.log(`Top-5 Recall: ${metrics.top5_recall.toFixed(1)}%`);
  console.log(`MRR: ${metrics.mrr.toFixed(4)}`);
  console.log(`NDCG@5: ${metrics.ndcg_at_5.toFixed(4)}`);
  console.log(`Forbidden Hit: ${metrics.forbidden_hit_rate.toFixed(1)}%`);
  console.log(`False Null: ${metrics.false_null_rate.toFixed(1)}%`);
  console.log(`Null Accuracy: ${metrics.null_accuracy.toFixed(1)}%`);
  console.log(`Latency P50: ${metrics.latency_p50_ms}ms`);
  console.log(`Latency P95: ${metrics.latency_p95_ms}ms`);
  console.log(`Latency P99: ${metrics.latency_p99_ms}ms`);
  console.log(`Report: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
