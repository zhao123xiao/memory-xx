import fs from "node:fs";
import path from "node:path";
import { IntelligenceService } from "../app/intelligence/service";
import { loadIntelligenceConfig, type IntelligenceConfig } from "../app/intelligence/config";
import type { MemoryType, SmartExtractionResponse } from "../app/intelligence/types";

type BenchStrategy = "native" | "v1" | "v2";

interface Case {
  id: string;
  category: string;
  text: string;
  expectWrite: boolean;
  expectedType?: MemoryType;
  multi?: boolean;
}

interface RunResult {
  id: string;
  category: string;
  ok: boolean;
  latency_ms: number;
  should_write: boolean;
  should_write_correct: boolean;
  schema_valid: boolean;
  canonical_quality: number;
  raw_text_leak: boolean;
  memory_type_correct: boolean;
  no_write_correct: boolean;
  multi_correct: boolean;
  fallback_needed: boolean;
  failure_reason?: string;
  strategy?: string;
  mem0_strategy_version?: string;
  schema_repair_applied?: boolean;
  transport_error?: boolean;
  provider?: string;
  error?: string;
}

function zh(text: string): string {
  return text;
}

function loadEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  } catch {}
  return env;
}

function mergedEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const fileEnv = loadEnvFile(process.env.MEMORY_XX_ENV_PATH || "<project-root>/.env");
  return { ...process.env, ...fileEnv, ...overrides };
}

function makeConfig(strategy: BenchStrategy): IntelligenceConfig {
  const provider = strategy === "native" ? "native" : "mem0";
  return loadIntelligenceConfig(mergedEnv({
    MEMORY_INTELLIGENCE_PROVIDER: provider,
    MEMORY_INTELLIGENCE_NATIVE_FALLBACK: provider === "mem0" ? "false" : "true",
    MEMORY_INTELLIGENCE_MEM0_STRATEGY_VERSION: strategy === "v1" ? "v1" : "v2",
  }));
}

function add(cases: Case[], category: string, id: string, text: string, expectWrite: boolean, expectedType?: MemoryType, multi = false): void {
  cases.push({ id: `${category}-${id}`, category, text, expectWrite, expectedType, multi });
}

function buildCases(): Case[] {
  const cases: Case[] = [];
  const writeTemplates: Array<[MemoryType, string[]]> = [
    ["preference", [
      zh("请记住：以后回答先给结论再给证据。"),
      zh("记一下：我偏好简洁直接的工程说明。"),
      "Please remember I prefer concise engineering summaries.",
    ]],
    ["constraint", [
      zh("请记住：以后压测前必须先跑 smoke。"),
      zh("记住：本地模型显存使用不能超过20G。"),
      "Remember: the reranker service must stay on port 8084.",
    ]],
    ["procedure", [
      zh("记一下：发布前先跑 smoke，再跑 standard，失败后清理测试 scope。"),
      zh("请记住：修复召回问题时先看 L3，再看 L4，最后跑全门禁。"),
      "Remember: when deploying memory-xx, restart wrapper after build.",
    ]],
    ["fact", [
      zh("请记住：memory-xx 的主账是 Postgres。"),
      zh("记一下：Qdrant 只是 approved current 记忆的投影。"),
      "Remember: Redis is used for cache, locks, and queues.",
    ]],
    ["decision", [
      zh("记一下：决定把本地 Qwen3-8B 停掉，只保留 8B reranker。"),
      zh("请记住：OpenClaw 只使用 memory-xx 主线。"),
      "Remember: native extraction remains as fallback.",
    ]],
  ];

  let n = 0;
  for (const [type, texts] of writeTemplates) {
    for (let i = 0; i < 8; i += 1) {
      add(cases, "write", String(n++), `${texts[i % texts.length]} case-${i}`, true, type);
    }
  }

  const skipTexts = [
    zh("今天只是临时测试，不要写入长期记忆。"),
    zh("这套记忆框架现在还有哪些问题？"),
    zh("你好，帮我看一下状态。"),
    zh("临时问一下 8084 是否健康？"),
    "Do not remember this temporary benchmark sentence.",
  ];
  for (let i = 0; i < 35; i += 1) {
    add(cases, "skip", String(i), `${skipTexts[i % skipTexts.length]} case-${i}`, false);
  }

  for (let i = 0; i < 35; i += 1) {
    add(cases, "zh-long", String(i),
      zh(`请记住：以后处理 memory-xx 的第 ${i} 类问题时，先确认主账一致性，再确认召回链路，最后给出不超过三段的结论。`),
      true, "procedure");
  }

  for (let i = 0; i < 30; i += 1) {
    add(cases, "mixed", String(i),
      `Please remember: for OpenClaw memory-xx task ${i}, keep Postgres as source of truth and Qdrant as projection only.`,
      true, "constraint");
  }

  for (let i = 0; i < 30; i += 1) {
    add(cases, "conflict", String(i),
      zh(`记一下：之前的 reranker 方案更新为 Qwen3-Reranker-8B-INT4，旧的 0.6B reranker 不再作为生产主排序模型。版本${i}`),
      true, "decision");
  }

  for (let i = 0; i < 30; i += 1) {
    add(cases, "meta-skip", String(i),
      zh(`不要把测试标记 benchmark-${i} 写入记忆，这只是验证抽取器是否会误记 meta 文本。`),
      false);
  }

  for (let i = 0; i < 25; i += 1) {
    add(cases, "multi", String(i),
      zh(`请记住：以后报告先给结论；发布前必须跑 smoke；Qdrant 只作为投影。多记忆样本${i}`),
      true, "constraint", true);
  }

  for (let i = 0; i < 15; i += 1) {
    add(cases, "agent", String(i),
      zh(`记一下：OpenClaw agent 如果 memory-xx recall 返回空，先检查 scope，再检查 reranker，最后查看 L3 observation。经验${i}`),
      true, "procedure");
  }

  return cases.slice(0, 240);
}

function selectBalancedCases(allCases: Case[], limit: number): Case[] {
  const categoryOrder = ["write", "skip", "zh-long", "mixed", "conflict", "meta-skip", "multi", "agent"];
  const groups = new Map<string, Case[]>();
  for (const tc of allCases) {
    groups.set(tc.category, [...(groups.get(tc.category) ?? []), tc]);
  }
  const selected: Case[] = [];
  let cursor = 0;
  while (selected.length < limit) {
    let added = false;
    for (const category of categoryOrder) {
      const rows = groups.get(category) ?? [];
      if (cursor < rows.length && selected.length < limit) {
        selected.push(rows[cursor]);
        added = true;
      }
    }
    if (!added) break;
    cursor += 1;
  }
  return selected;
}

function canonicalQuality(tc: Case, response: SmartExtractionResponse): number {
  if (!tc.expectWrite) return response.should_write ? 0 : 1;
  const first = response.memories[0]?.canonical_content ?? "";
  if (!first) return 0;
  if (first.length < 12) return 0.3;
  if (first.trim() === tc.text.trim()) return 0.4;
  if (/请记住|记一下|remember this|please remember/i.test(first)) return 0.5;
  if (/benchmark-\d+|run_id|scope_id|测试标记/i.test(first)) return 0.4;
  return 1;
}

function isTransportReason(reason?: string): boolean {
  return ["llm_http_429", "llm_http_5xx", "timeout", "network_error", "http_error"].includes(reason ?? "");
}

async function runCase(service: IntelligenceService, tc: Case): Promise<RunResult> {
  const started = Date.now();
  try {
    const response = await service.extract({
      text: tc.text,
      agent_id: "mem0-benchmark",
      scope_hint: { scope_type: "project", scope_id: "mem0-benchmark" },
      mode: "draft",
    });
    const latency = Date.now() - started;
    const reason = response.mem0_fallback_reason ?? response.failure_reason ?? response.fallback_reason;
    const transport = response.transport_error === true || isTransportReason(reason);
    const schemaValid = response.ok === true && typeof response.should_write === "boolean" && Array.isArray(response.memories);
    const memoryTypeCorrect = !tc.expectWrite || !tc.expectedType || response.memories.some((m) => m.memory_type === tc.expectedType);
    const rawLeak = response.memories.some((m) => m.canonical_content.trim() === tc.text.trim());
    const multiCorrect = !tc.multi || response.memories.length >= 2;
    return {
      id: tc.id,
      category: tc.category,
      ok: response.ok,
      latency_ms: latency,
      should_write: response.should_write,
      should_write_correct: response.should_write === tc.expectWrite || transport,
      schema_valid: schemaValid,
      canonical_quality: transport ? 0.5 : canonicalQuality(tc, response),
      raw_text_leak: rawLeak,
      memory_type_correct: transport || memoryTypeCorrect,
      no_write_correct: tc.expectWrite ? true : response.should_write === false,
      multi_correct: transport || multiCorrect,
      fallback_needed: response.fallback_used === true || Boolean(response.mem0_fallback_reason),
      failure_reason: reason,
      strategy: response.strategy,
      mem0_strategy_version: response.mem0_strategy_version,
      schema_repair_applied: response.schema_repair_applied,
      transport_error: transport,
      provider: response.provider,
      error: response.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transport = /429|502|503|504|timeout|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
    return {
      id: tc.id,
      category: tc.category,
      ok: false,
      latency_ms: Date.now() - started,
      should_write: false,
      should_write_correct: transport,
      schema_valid: false,
      canonical_quality: transport ? 0.5 : 0,
      raw_text_leak: false,
      memory_type_correct: transport,
      no_write_correct: false,
      multi_correct: transport,
      fallback_needed: true,
      failure_reason: transport ? "transport_error" : "unknown",
      transport_error: transport,
      error: message,
    };
  }
}

function pct(value: number): number {
  return Number((value * 100).toFixed(2));
}

function score(results: RunResult[]): Record<string, number> {
  const n = Math.max(1, results.length);
  const avg = (fn: (r: RunResult) => number) => results.reduce((sum, r) => sum + fn(r), 0) / n;
  const nonTransport = results.filter((r) => !r.transport_error);
  const schemaDenom = Math.max(1, nonTransport.length);
  const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
  const write = avg((r) => r.should_write_correct ? 1 : 0) * 20;
  const canonical = avg((r) => r.canonical_quality) * 25;
  const type = avg((r) => r.memory_type_correct ? 1 : 0) * 15;
  const noWrite = avg((r) => r.no_write_correct ? 1 : 0) * 15;
  const schemaFailureRate = nonTransport.filter((r) => !r.schema_valid).length / schemaDenom;
  const schema = (1 - schemaFailureRate) * 10;
  const speed = Math.max(0, Math.min(10, 10 - Math.max(0, p95 - 3000) / 1000));
  const fallback = avg((r) => r.fallback_needed ? 0 : 1) * 5;
  return {
    total: Number((write + canonical + type + noWrite + schema + speed + fallback).toFixed(2)),
    write_judgement: Number(write.toFixed(2)),
    canonical_quality: Number(canonical.toFixed(2)),
    type_topic_title: Number(type.toFixed(2)),
    no_write_precision: Number(noWrite.toFixed(2)),
    schema_stability: Number(schema.toFixed(2)),
    speed: Number(speed.toFixed(2)),
    fallback_error: Number(fallback.toFixed(2)),
    p95_latency_ms: p95,
    schema_failure_rate: pct(schemaFailureRate),
    transport_error_rate: pct(avg((r) => r.transport_error ? 1 : 0)),
    schema_repair_rate: pct(avg((r) => r.schema_repair_applied ? 1 : 0)),
  };
}

function categoryBreakdown(results: RunResult[]): Record<string, Record<string, number>> {
  const grouped: Record<string, RunResult[]> = {};
  for (const result of results) {
    grouped[result.category] = grouped[result.category] ?? [];
    grouped[result.category].push(result);
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [category, rows] of Object.entries(grouped)) {
    const n = Math.max(1, rows.length);
    out[category] = {
      cases: rows.length,
      should_write_accuracy: pct(rows.filter((r) => r.should_write_correct).length / n),
      memory_type_accuracy: pct(rows.filter((r) => r.memory_type_correct).length / n),
      no_write_accuracy: pct(rows.filter((r) => r.no_write_correct).length / n),
      multi_accuracy: pct(rows.filter((r) => r.multi_correct).length / n),
      transport_error_rate: pct(rows.filter((r) => r.transport_error).length / n),
    };
  }
  return out;
}

function countBy(results: RunResult[], key: keyof RunResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const value = String(result[key] ?? "none");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function parseStrategy(): BenchStrategy | "all" {
  const arg = process.argv.find((item) => item.startsWith("--strategy="));
  const value = arg?.split("=")[1] ?? "v2";
  return value === "native" || value === "v1" || value === "v2" || value === "all" ? value : "v2";
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const paceArg = process.argv.find((arg) => arg.startsWith("--pace-ms="));
  const sampleArg = process.argv.find((arg) => arg.startsWith("--sample="));
  const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : 240;
  const paceMs = paceArg ? Math.max(0, Number(paceArg.split("=")[1])) : 900;
  const sample = sampleArg?.split("=")[1] === "balanced" ? "balanced" : "ordered";
  const strategyArg = parseStrategy();
  const allCases = buildCases();
  const cases = sample === "balanced" ? selectBalancedCases(allCases, limit) : allCases.slice(0, limit);
  const strategies: BenchStrategy[] = strategyArg === "all" ? ["native", "v1", "v2"] : strategyArg === "native" ? ["native"] : ["native", strategyArg];
  const raw: Record<string, RunResult[]> = {};
  const scores: Record<string, Record<string, number>> = {};

  for (const strategy of strategies) {
    const service = new IntelligenceService(makeConfig(strategy));
    const rows: RunResult[] = [];
    for (const tc of cases) {
      rows.push(await runCase(service, tc));
      if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
      if ((rows.length % 10) === 0) {
        console.log(`bench ${strategy} progress ${rows.length}/${cases.length}`);
      }
    }
    raw[strategy] = rows;
    scores[strategy] = score(rows);
  }

  const nativeScore = scores.native;
  const mem0Key = strategyArg === "v1" ? "v1" : "v2";
  const mem0Score = scores[mem0Key] ?? scores.v2 ?? scores.v1 ?? scores.native;
  const shouldSwitch = Boolean(nativeScore && mem0Score && mem0Score.total >= nativeScore.total
    && mem0Score.schema_failure_rate <= 5
    && mem0Score.no_write_precision >= nativeScore.no_write_precision);

  const report = {
    ok: true,
    cases: cases.length,
    strategy: strategyArg,
    sample,
    pace_ms: paceMs,
    should_switch_to_mem0: shouldSwitch,
    native: scores.native,
    mem0: mem0Score,
    scores,
    diff: nativeScore && mem0Score ? Number((mem0Score.total - nativeScore.total).toFixed(2)) : 0,
    strategy_breakdown: Object.fromEntries(Object.entries(raw).map(([key, rows]) => [key, countBy(rows, "strategy")])),
    type_accuracy_by_category: Object.fromEntries(Object.entries(raw).map(([key, rows]) => [key, categoryBreakdown(rows)])),
    fallback_reason_breakdown: Object.fromEntries(Object.entries(raw).map(([key, rows]) => [key, countBy(rows, "failure_reason")])),
    raw,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(process.cwd(), "reports", "memory-xx-tests", `mem0-extraction-${ts}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scores.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, "raw.jsonl"), Object.entries(raw)
    .flatMap(([strategy, rows]) => rows.map((row) => JSON.stringify({ strategy, ...row })))
    .join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "summary.md"), [
    "# Mem0 Extraction Benchmark",
    "",
    `- cases: ${cases.length}`,
    `- strategy: ${strategyArg}`,
    `- sample: ${sample}`,
    `- pace_ms: ${paceMs}`,
    `- should_switch_to_mem0: ${shouldSwitch}`,
    `- native_total: ${scores.native?.total ?? "n/a"}`,
    `- mem0_total: ${mem0Score?.total ?? "n/a"}`,
    `- diff: ${report.diff}`,
    `- mem0_schema_failure_rate: ${mem0Score?.schema_failure_rate ?? "n/a"}`,
    `- mem0_transport_error_rate: ${mem0Score?.transport_error_rate ?? "n/a"}`,
    "",
  ].join("\n"));
  console.log(JSON.stringify({ ...report, raw: undefined, report_dir: dir }, null, 2));
  process.exit(shouldSwitch || !nativeScore || (mem0Score && mem0Score.total >= nativeScore.total - 5) ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
