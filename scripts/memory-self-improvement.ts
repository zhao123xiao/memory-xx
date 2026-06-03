#!/usr/bin/env tsx
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

import { IntelligenceLLMClient } from "../app/intelligence/llm-client";
import { loadIntelligenceConfig } from "../app/intelligence/config";

const execFileAsync = promisify(execFile);

function loadLocalEnv(): Record<string, string> {
  const envPath = process.env.MEMORY_V2_ENV_PATH?.trim() || path.join(process.cwd(), ".env");
  const loaded: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx);
      const value = trimmed.slice(idx + 1);
      loaded[key] = value;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Missing .env is acceptable in tests and explicitly configured environments.
  }
  return loaded;
}

const localEnv = loadLocalEnv();

function env(key: string, fallback = ""): string {
  return process.env[key] || localEnv[key] || fallback;
}

const runtimeConfig = {
  wrapperUrl: env("MEMORY_V2_WRAPPER_URL", `http://127.0.0.1:${env("MEMORY_V2_WRAPPER_PORT", "5100")}`).replace(/\/+$/, ""),
  wrapperToken: env("MEMORY_V2_ADMIN_TOKEN", env("MEMORY_V2_API_TOKEN")),
  dbUrl: env("MEMORY_V2_DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/memory_xx"),
  dbSchema: env("MEMORY_V2_DATABASE_SCHEMA", "memory_xx"),
};

function createPool(): pg.Pool {
  const url = new URL(runtimeConfig.dbUrl);
  return new pg.Pool({
    host: url.hostname,
    port: parseInt(url.port || "5432", 10),
    database: url.pathname.slice(1),
    user: url.username,
    password: decodeURIComponent(url.password),
    max: 5,
    idleTimeoutMillis: 10000,
  });
}

async function query(pool: pg.Pool, sql: string, params?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}

export type SelfImprovementEntryType = "learning" | "error" | "feature_request" | "ops_proposal";
export type SelfImprovementPriority = "low" | "medium" | "high" | "critical";
export type SelfImprovementStatus = "pending" | "in_progress" | "resolved" | "promoted" | "wont_fix";
export type SelfImprovementArea = "frontend" | "backend" | "infra" | "tests" | "docs" | "config";

export interface SelfImprovementEntry {
  readonly entry_id: string;
  readonly type: SelfImprovementEntryType;
  readonly priority: SelfImprovementPriority;
  readonly status: SelfImprovementStatus;
  readonly area: SelfImprovementArea;
  readonly summary: string;
  readonly details: string;
  readonly suggested_action: string;
  readonly evidence: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly pattern_key: string;
  readonly see_also: readonly string[];
  readonly recurrence_count: number;
  readonly first_seen: string;
  readonly last_seen: string;
  readonly promotion_candidate: boolean;
}

export interface ExistingEntry {
  readonly memory_id: string;
  readonly entry_id: string | null;
  readonly recurrence_count: number;
  readonly first_seen: string | null;
  readonly see_also: readonly string[];
}

interface CliOptions {
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly writeMarkdown: boolean;
  readonly writeMemory: boolean;
  readonly scopeId: string;
  readonly recurrencePromoteThreshold: number;
  readonly skipQuality: boolean;
  readonly deterministic: boolean;
  readonly collectorTimeoutMs: number;
  readonly llmTimeoutMs: number;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argNumber(name: string, fallback: number): number {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const raw = index >= 0
    ? (process.argv[index] === name ? process.argv[index + 1] : process.argv[index]!.slice(prefix.length))
    : undefined;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readOptions(): CliOptions {
  const threshold = Number.parseInt(process.env.MEMORY_V2_SELF_IMPROVEMENT_RECURRENCE_PROMOTE_THRESHOLD ?? "3", 10);
  return {
    dryRun: hasArg("--dry-run"),
    json: hasArg("--json"),
    writeMarkdown: hasArg("--write-markdown") || envFlag("MEMORY_V2_SELF_IMPROVEMENT_MARKDOWN", false),
    writeMemory: !hasArg("--no-write-memory"),
    scopeId: process.env.MEMORY_V2_SELF_IMPROVEMENT_SCOPE_ID?.trim() || "memory-xx-self-improvement",
    recurrencePromoteThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 3,
    skipQuality: hasArg("--skip-quality"),
    deterministic: hasArg("--deterministic"),
    collectorTimeoutMs: argNumber("--collector-timeout-ms", Number.parseInt(process.env.MEMORY_V2_SELF_IMPROVEMENT_COLLECTOR_TIMEOUT_MS ?? "90000", 10) || 90_000),
    llmTimeoutMs: argNumber("--llm-timeout-ms", Number.parseInt(process.env.MEMORY_V2_SELF_IMPROVEMENT_LLM_TIMEOUT_MS ?? "45000", 10) || 45_000),
  };
}

export function extractLastJsonObject(stdout: string): Record<string, unknown> {
  const raw = stdout.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    // npm without --silent can prepend lifecycle banners. Walk from the end and
    // parse the last complete JSON object instead of treating the command as failed.
  }
  for (let index = raw.lastIndexOf("{"); index >= 0; index = raw.lastIndexOf("{", index - 1)) {
    const candidate = raw.slice(index).trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`stdout_json_parse_failed:${raw.slice(0, 160)}`);
}

export async function commandJson(scriptName: string, args: readonly string[], timeoutMs = 90_000): Promise<Record<string, unknown>> {
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["--silent", "run", scriptName, "--", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = extractLastJsonObject(stdout.toString());
    return stderr.toString().trim() ? { ...parsed, command_stderr: redactText(stderr.toString(), 1200) } : parsed;
  } catch (error) {
    const stdout = typeof (error as { stdout?: unknown }).stdout === "string" || Buffer.isBuffer((error as { stdout?: unknown }).stdout)
      ? String((error as { stdout?: unknown }).stdout)
      : "";
    if (stdout.trim()) {
      try {
        return {
          ...extractLastJsonObject(stdout),
          command_exit_error: error instanceof Error ? redactText(error.message, 1200) : redactText(String(error), 1200),
        };
      } catch {
        // Fall through to compact error object.
      }
    }
    return {
      ok: false,
      error: error instanceof Error ? redactText(error.message, 1200) : redactText(String(error), 1200),
    };
  }
}

async function recentRecallFailures(): Promise<readonly Record<string, unknown>[]> {
  const pool = createPool();
  try {
    const rows = await query(pool, `
      SELECT id, query_excerpt, query_type, degrade_level,
             audit -> 'rerank' AS rerank,
             audit ->> 'fallback_reason' AS fallback_reason,
             created_at
      FROM ${quoteTable("recall_traces")}
      WHERE degrade_level > 0
         OR audit -> 'rerank' ->> 'model_used' = 'false'
         OR audit ->> 'fallback_used' = 'true'
      ORDER BY created_at DESC
      LIMIT 20
    `);
    return rows.rows;
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  } finally {
    await closePool(pool);
  }
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return `"${value}"`;
}

function quoteTable(name: string): string {
  return `${quoteIdent(runtimeConfig.dbSchema)}.${quoteIdent(name)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? redactText(value.trim(), 3000) : fallback;
}

function cleanStringArray(value: unknown, limit = 8): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter(Boolean).slice(0, limit);
}

function redactText(value: string, max = 4000): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"'`]+/gi, "$1[REDACTED]")
    .slice(0, max);
}

function sanitizeEvidence(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return redactText(value, 1200);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeEvidence(item, depth + 1));
  if (!isRecord(value)) return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (/token|password|secret|api[_-]?key|authorization/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = sanitizeEvidence(item, depth + 1);
    }
  }
  return output;
}

function patternKey(type: SelfImprovementEntryType, summary: string, evidence: Record<string, unknown>): string {
  const stable = JSON.stringify({ type, summary: summary.toLowerCase(), evidence: Object.keys(evidence).sort() });
  return `${type}.${createHash("sha256").update(stable).digest("hex").slice(0, 16)}`;
}

function entryPrefix(type: SelfImprovementEntryType): string {
  if (type === "error") return "ERR";
  if (type === "feature_request") return "FEAT";
  return "LRN";
}

function isCommandCollectionFailure(result: Record<string, unknown>): boolean {
  const error = cleanString(result.error);
  return Boolean(error && !result.command_exit_error);
}

function statusBlockers(result: Record<string, unknown>): readonly unknown[] {
  const direct = asArray(result.blockers);
  const doctor = isRecord(result.doctor) ? asArray(result.doctor.blockers) : [];
  return [...direct, ...doctor];
}

function isSelfImprovementPendingStatus(result: Record<string, unknown>): boolean {
  const pending = isRecord(result.pending) ? result.pending : {};
  const current = Number(pending.candidate_current ?? 0);
  if (!Number.isFinite(current) || current <= 0) return false;
  const groups = asArray(pending.groups).filter(isRecord);
  if (groups.length === 0) return true;
  return groups.every((group) => {
    const source = cleanString(group.source).toLowerCase();
    const agentId = cleanString(group.agent_id).toLowerCase();
    const age = cleanString(group.age_bucket).toLowerCase();
    const isSelfImprovement = source.includes("self-improvement") || agentId.includes("self-improvement");
    const isFresh = !age || age === "lt_1d" || age === "lt_1h";
    return isSelfImprovement && isFresh;
  });
}

function isPendingReviewDebtStatus(result: Record<string, unknown>): boolean {
  const pending = isRecord(result.pending) ? result.pending : {};
  const current = Number(pending.candidate_current ?? 0);
  return Number.isFinite(current) && current > 0;
}

function makeEntry(input: {
  readonly type: SelfImprovementEntryType;
  readonly priority: SelfImprovementPriority;
  readonly area: SelfImprovementArea;
  readonly summary: string;
  readonly details: string;
  readonly suggested_action: string;
  readonly evidence: Record<string, unknown>;
  readonly tags?: readonly string[];
  readonly now: string;
  readonly recurrenceThreshold: number;
}): SelfImprovementEntry {
  const key = patternKey(input.type, input.summary, input.evidence);
  const ymd = input.now.slice(0, 10).replace(/-/g, "");
  return {
    entry_id: `${entryPrefix(input.type)}-${ymd}-${randomUUID().slice(0, 3).toUpperCase()}`,
    type: input.type,
    priority: input.priority,
    status: "pending",
    area: input.area,
    summary: input.summary,
    details: input.details,
    suggested_action: input.suggested_action,
    evidence: sanitizeEvidence(input.evidence) as Record<string, unknown>,
    tags: input.tags ?? [],
    pattern_key: key,
    see_also: [],
    recurrence_count: 1,
    first_seen: input.now,
    last_seen: input.now,
    promotion_candidate: input.recurrenceThreshold <= 1,
  };
}

export function buildDeterministicEntries(
  input: Record<string, unknown>,
  proposal: Record<string, unknown>,
  options: { readonly now?: string; readonly recurrenceThreshold?: number } = {},
): readonly SelfImprovementEntry[] {
  const now = options.now ?? new Date().toISOString();
  const recurrenceThreshold = options.recurrenceThreshold ?? 3;
  const entries: SelfImprovementEntry[] = [];
  const doctor = isRecord(input.doctor) ? input.doctor : {};
  const status = isRecord(input.status) ? input.status : {};
  const quality = isRecord(input.quality) ? input.quality : {};
  const failures = asArray(input.recent_recall_failures).filter(isRecord);
  const blockers = asArray(doctor.blockers);
  const warnings = asArray(doctor.warnings);
  const recommended = cleanStringArray(proposal.recommended_actions, 8);
  const validation = cleanStringArray(proposal.validation_commands, 8);

  for (const [name, result] of Object.entries({ doctor, status, quality })) {
    if (isRecord(result) && result.ok === false) {
      if (name === "status" && statusBlockers(result).length === 0 && isPendingReviewDebtStatus(result)) {
        const pending = isRecord(result.pending) ? result.pending : {};
        const selfImprovementOnly = isSelfImprovementPendingStatus(result);
        entries.push(makeEntry({
          type: "ops_proposal",
          priority: "medium",
          area: "infra",
          summary: selfImprovementOnly
            ? "memory-xx has pending self-improvement suggestions awaiting approval"
            : "memory-xx has pending memory candidates awaiting approval",
          details: selfImprovementOnly
            ? "memory:status reported ok=false because pending candidate memories are present. Fresh memory:self-improvement candidates are normal review debt, not evidence that the memory system is broken."
            : "memory:status reported ok=false because candidate memories are waiting for review. Pending conversation or ops candidates are approval backlog, not a runtime failure when doctor has no blockers.",
          suggested_action: selfImprovementOnly
            ? "Review pending memory:self-improvement candidates, approve useful ops learnings, and reject stale or duplicate suggestions."
            : "Review pending candidates by source and scope; use pending governance only for explicit test scopes.",
          evidence: { command: name, pending },
          tags: selfImprovementOnly
            ? ["self-improvement", "status", "pending-review"]
            : ["status", "pending-review", "approval-backlog"],
          now,
          recurrenceThreshold,
        }));
        continue;
      }
      entries.push(makeEntry({
        type: "error",
        priority: isCommandCollectionFailure(result) ? "high" : name === "status" ? "medium" : "high",
        area: name === "quality" ? "tests" : "infra",
        summary: `${name} command returned an invalid or failing result`,
        details: isCommandCollectionFailure(result)
          ? `memory:self-improvement could not use ${name} as a clean JSON signal. This usually means the command failed, timed out, or returned non-JSON output.`
          : `${name} returned parseable JSON with ok=false. Treat this as degraded state evidence and inspect its structured reasons before declaring a system fault.`,
        suggested_action: `Run TMPDIR=/tmp npm run memory:${name} -- --json and inspect the raw output before trusting self-improvement diagnosis.`,
        evidence: { command: name, result },
        tags: ["self-improvement", name, "command-json"],
        now,
        recurrenceThreshold,
      }));
    }
  }

  if (blockers.length > 0 || warnings.length > 0) {
    entries.push(makeEntry({
      type: blockers.length > 0 ? "error" : "learning",
      priority: blockers.length > 0 ? "critical" : "medium",
      area: "infra",
      summary: blockers.length > 0 ? "memory-xx doctor reported blockers" : "memory-xx doctor reported warnings",
      details: blockers.length > 0
        ? "The doctor gate found blocking conditions that require operator review."
        : "The doctor gate found non-blocking conditions that should be tracked for recurrence.",
      suggested_action: recommended[0] ?? "Review memory:doctor output and run the relevant validation gate after manual changes.",
      evidence: { blockers, warnings },
      tags: ["doctor", "ops"],
      now,
      recurrenceThreshold,
    }));
  }

  if (failures.length > 0) {
    entries.push(makeEntry({
      type: "learning",
      priority: failures.length >= 5 ? "high" : "medium",
      area: "backend",
      summary: "recent recall traces show degraded retrieval or reranker fallback",
      details: "Self-improvement observed recent recall traces with degrade_level, disabled model rerank, or fallback usage. These samples should be reviewed before changing recall policy.",
      suggested_action: "Use the trace ids as fixtures for recall/reranker regression tests before tuning retrieval policy.",
      evidence: { recent_recall_failures: failures.slice(0, 10) },
      tags: ["recall", "reranker", "quality"],
      now,
      recurrenceThreshold,
    }));
  }

  entries.push(makeEntry({
    type: "ops_proposal",
    priority: proposal.risk === "critical" ? "critical" : proposal.risk === "high" ? "high" : "medium",
    area: "infra",
    summary: cleanString(proposal.diagnosis, "memory-xx self-improvement generated an ops proposal"),
    details: "Report-only self-improvement proposal generated from doctor, status, quality, and recent recall failure signals.",
    suggested_action: recommended.join("; ") || "Review the proposal and validate with memory:doctor and test gates.",
    evidence: {
      proposal_evidence: isRecord(proposal.evidence) ? proposal.evidence : {},
      validation_commands: validation,
    },
    tags: ["ops", "self-improvement", "report-only"],
    now,
    recurrenceThreshold,
  }));

  return entries;
}

function normalizePriority(value: unknown): SelfImprovementPriority {
  return value === "low" || value === "medium" || value === "high" || value === "critical" ? value : "medium";
}

function normalizeType(value: unknown): SelfImprovementEntryType {
  return value === "learning" || value === "error" || value === "feature_request" || value === "ops_proposal" ? value : "ops_proposal";
}

function normalizeStatus(value: unknown): SelfImprovementStatus {
  return value === "in_progress" || value === "resolved" || value === "promoted" || value === "wont_fix" ? value : "pending";
}

function normalizeArea(value: unknown): SelfImprovementArea {
  return value === "frontend" || value === "backend" || value === "infra" || value === "tests" || value === "docs" || value === "config" ? value : "infra";
}

function normalizeLlmEntries(value: unknown, now: string, recurrenceThreshold: number): readonly SelfImprovementEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((raw) => {
    const type = normalizeType(raw.type);
    const summary = cleanString(raw.summary, "memory-xx self-improvement entry");
    const evidence = sanitizeEvidence(isRecord(raw.evidence) ? raw.evidence : {}) as Record<string, unknown>;
    const key = cleanString(raw.pattern_key) || patternKey(type, summary, evidence);
    return {
      entry_id: cleanString(raw.entry_id) || `${entryPrefix(type)}-${now.slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 3).toUpperCase()}`,
      type,
      priority: normalizePriority(raw.priority),
      status: normalizeStatus(raw.status),
      area: normalizeArea(raw.area),
      summary,
      details: cleanString(raw.details, summary),
      suggested_action: cleanString(raw.suggested_action, "Review and validate manually; do not auto-apply repairs."),
      evidence,
      tags: cleanStringArray(raw.tags, 12),
      pattern_key: key,
      see_also: cleanStringArray(raw.see_also, 12),
      recurrence_count: 1,
      first_seen: now,
      last_seen: now,
      promotion_candidate: recurrenceThreshold <= 1,
    };
  });
}

function fallbackProposal(input: Record<string, unknown>): Record<string, unknown> {
  const doctor = input.doctor as Record<string, unknown> | undefined;
  const blockers = Array.isArray(doctor?.blockers) ? doctor.blockers : [];
  const warnings = Array.isArray(doctor?.warnings) ? doctor.warnings : [];
  return {
    ok: true,
    mode: "deterministic_fallback",
    diagnosis: blockers.length > 0
      ? `memory-xx has ${blockers.length} blocker(s); operator review is required.`
      : warnings.length > 0
        ? `memory-xx is usable with ${warnings.length} warning(s).`
        : "memory-xx doctor did not report blockers or warnings.",
    evidence: {
      blockers,
      warnings,
      recent_recall_failures: input.recent_recall_failures,
    },
    recommended_actions: [
      "Review memory:doctor output before changing services.",
      "Run the relevant gate after any manual repair.",
      "Do not auto-apply destructive repairs from self-improvement output.",
    ],
    risk: "report_only",
    validation_commands: [
      "TMPDIR=/tmp npm run memory:doctor -- --target ops-ready --mode full --plan",
      "TMPDIR=/tmp npm run test:all-gates -- --all",
    ],
  };
}

async function llmProposal(input: Record<string, unknown>, now: string, recurrenceThreshold: number): Promise<{ proposal: Record<string, unknown>; entries: readonly SelfImprovementEntry[] }> {
  const intelligenceConfig = loadIntelligenceConfig();
  const client = new IntelligenceLLMClient(intelligenceConfig);
  const system = [
    "You are the memory-xx self-improvement ops agent.",
    "Return strict JSON only.",
    "You may diagnose and recommend actions, but you must not claim that you executed repairs.",
    "Classify findings using the self-improvement taxonomy: learning, error, feature_request, ops_proposal.",
    "Never include secrets, raw tokens, full environment dumps, or raw transcripts.",
    "Schema: {ok:boolean, diagnosis:string, evidence:object, recommended_actions:string[], risk:string, validation_commands:string[], entries:[{type:string,priority:string,status:string,area:string,summary:string,details:string,suggested_action:string,evidence:object,tags:string[],pattern_key?:string,see_also?:string[]}]}."
  ].join("\n");
  const user = JSON.stringify(input).slice(0, 24_000);
  const result = await client.call(system, user);
  const proposal = result.ok && result.parsed && typeof result.parsed === "object"
    ? result.parsed as Record<string, unknown>
    : fallbackProposal(input);
  const llmEntries = normalizeLlmEntries(proposal.entries, now, recurrenceThreshold);
  return {
    proposal,
    entries: llmEntries.length > 0 ? llmEntries : buildDeterministicEntries(input, proposal, { now, recurrenceThreshold }),
  };
}

async function findExistingEntry(scopeId: string, patternKey: string): Promise<ExistingEntry | null> {
  const pool = createPool();
  try {
    const rows = await query(pool, `
      SELECT id, metadata, created_at
      FROM ${quoteTable("memory_records")}
      WHERE scope_type = 'project'
        AND scope_id = $1
        AND is_current IS TRUE
        AND (
          metadata #>> '{self_improvement,pattern_key}' = $2
          OR content ILIKE $3
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `, [scopeId, patternKey, `%Pattern-Key: ${patternKey}%`]);
    const row = rows.rows[0];
    if (!row) return null;
    const metadata = isRecord(row.metadata) ? row.metadata : {};
    const si = isRecord(metadata.self_improvement) ? metadata.self_improvement : {};
    return {
      memory_id: String(row.id),
      entry_id: typeof si.entry_id === "string" ? si.entry_id : null,
      recurrence_count: typeof si.recurrence_count === "number" ? si.recurrence_count : 1,
      first_seen: typeof si.first_seen === "string" ? si.first_seen : String(row.created_at ?? ""),
      see_also: cleanStringArray(si.see_also, 20),
    };
  } finally {
    await closePool(pool);
  }
}

export function mergeExistingEntry(entry: SelfImprovementEntry, existing: ExistingEntry, threshold: number): SelfImprovementEntry {
  const recurrence = Math.max(1, existing.recurrence_count) + 1;
  const seeAlso = Array.from(new Set([...entry.see_also, existing.memory_id, ...(existing.entry_id ? [existing.entry_id] : []), ...existing.see_also]));
  return {
    ...entry,
    entry_id: existing.entry_id ?? entry.entry_id,
    recurrence_count: recurrence,
    first_seen: existing.first_seen || entry.first_seen,
    see_also: seeAlso,
    promotion_candidate: recurrence >= threshold,
  };
}

async function updateExistingEntry(memoryId: string, entry: SelfImprovementEntry): Promise<Record<string, unknown>> {
  const pool = createPool();
  try {
    const metadata = JSON.stringify({ self_improvement: entry });
    const result = await query(pool, `
      UPDATE ${quoteTable("memory_records")}
      SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
          updated_at = now(),
          updated_by = 'memory-xx-self-improvement'
      WHERE id = $1
      RETURNING id, updated_at
    `, [memoryId, metadata]);
    return { action: "updated_existing", memory_id: result.rows[0]?.id ?? memoryId, updated_at: result.rows[0]?.updated_at };
  } finally {
    await closePool(pool);
  }
}

function entryText(entry: SelfImprovementEntry): string {
  return [
    "memory-xx self-improvement entry.",
    `Type: ${entry.type}`,
    `Entry-ID: ${entry.entry_id}`,
    `Pattern-Key: ${entry.pattern_key}`,
    `Priority: ${entry.priority}`,
    `Status: ${entry.status}`,
    `Area: ${entry.area}`,
    `Recurrence-Count: ${entry.recurrence_count}`,
    `Promotion-Candidate: ${entry.promotion_candidate}`,
    `Summary: ${entry.summary}`,
    `Details: ${entry.details}`,
    `Suggested Action: ${entry.suggested_action}`,
    `Tags: ${entry.tags.join(", ")}`,
    `See Also: ${entry.see_also.join(", ")}`,
    `Evidence: ${JSON.stringify(entry.evidence)}`,
  ].join("\n");
}

async function writeEntry(entry: SelfImprovementEntry, scopeId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${runtimeConfig.wrapperUrl}/api/memory/v2/write`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(runtimeConfig.wrapperToken ? { authorization: `Bearer ${runtimeConfig.wrapperToken}`, "x-api-key": runtimeConfig.wrapperToken } : {}),
    },
    body: JSON.stringify({
      content: entryText(entry),
      title: `[SELF-IMPROVEMENT:${entry.type}] ${entry.summary}`.slice(0, 180),
      scopeType: "project",
      scopeId,
      requestId: `self-improvement-${entry.pattern_key}-${entry.last_seen}`,
      actorId: "memory-xx-self-improvement",
      dedupeKey: entry.pattern_key,
      memoryType: entry.type === "error" ? "lesson" : entry.type === "feature_request" ? "todo" : "status",
      lifecycleStatus: "candidate",
      reviewState: "pending",
      metadata: {
        source: "memory:self-improvement",
        memory_type: entry.type === "feature_request" ? "todo" : entry.type === "error" ? "lesson" : "status",
        topic: "self-improvement",
        self_improvement: entry,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { action: "created_candidate", status: response.status, body };
}

export async function writeEntries(entries: readonly SelfImprovementEntry[], options: CliOptions): Promise<readonly Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const existing = await findExistingEntry(options.scopeId, entry.pattern_key);
    if (existing) {
      results.push(await updateExistingEntry(existing.memory_id, mergeExistingEntry(entry, existing, options.recurrencePromoteThreshold)));
      continue;
    }
    results.push(await writeEntry(entry, options.scopeId));
  }
  return results;
}

function learningHeader(): string {
  return "# Learnings\n\nCorrections, insights, and knowledge gaps captured during development.\n\n**Categories**: correction | insight | knowledge_gap | best_practice\n\n---\n";
}

function errorsHeader(): string {
  return "# Errors\n\nCommand failures and integration errors.\n\n---\n";
}

function featuresHeader(): string {
  return "# Feature Requests\n\nCapabilities requested by the user.\n\n---\n";
}

async function ensureLearningFiles(rootDir: string): Promise<void> {
  const dir = path.join(rootDir, ".learnings");
  await mkdir(dir, { recursive: true });
  const files = [
    ["LEARNINGS.md", learningHeader()],
    ["ERRORS.md", errorsHeader()],
    ["FEATURE_REQUESTS.md", featuresHeader()],
  ] as const;
  for (const [file, header] of files) {
    const target = path.join(dir, file);
    if (!existsSync(target)) {
      await writeFile(target, header, { mode: 0o600 });
    }
  }
}

function markdownFile(entry: SelfImprovementEntry): string {
  if (entry.type === "error") return "ERRORS.md";
  if (entry.type === "feature_request") return "FEATURE_REQUESTS.md";
  return "LEARNINGS.md";
}

function markdownEntry(entry: SelfImprovementEntry): string {
  if (entry.type === "error") {
    return `\n## [${entry.entry_id}] ${entry.summary}\n\n**Logged**: ${entry.last_seen}\n**Priority**: ${entry.priority}\n**Status**: ${entry.status}\n**Area**: ${entry.area}\n\n### Summary\n${entry.summary}\n\n### Error\n\`\`\`\n${redactText(JSON.stringify(entry.evidence, null, 2), 2000)}\n\`\`\`\n\n### Context\n${entry.details}\n\n### Suggested Fix\n${entry.suggested_action}\n\n### Metadata\n- Reproducible: unknown\n- Pattern-Key: ${entry.pattern_key}\n- Recurrence-Count: ${entry.recurrence_count}\n- See Also: ${entry.see_also.join(", ") || "none"}\n\n---\n`;
  }
  if (entry.type === "feature_request") {
    return `\n## [${entry.entry_id}] ${entry.summary}\n\n**Logged**: ${entry.last_seen}\n**Priority**: ${entry.priority}\n**Status**: ${entry.status}\n**Area**: ${entry.area}\n\n### Requested Capability\n${entry.summary}\n\n### User Context\n${entry.details}\n\n### Complexity Estimate\nmedium\n\n### Suggested Implementation\n${entry.suggested_action}\n\n### Metadata\n- Frequency: ${entry.recurrence_count > 1 ? "recurring" : "first_time"}\n- Pattern-Key: ${entry.pattern_key}\n- Recurrence-Count: ${entry.recurrence_count}\n\n---\n`;
  }
  return `\n## [${entry.entry_id}] ${entry.type === "ops_proposal" ? "best_practice" : "insight"}\n\n**Logged**: ${entry.last_seen}\n**Priority**: ${entry.priority}\n**Status**: ${entry.status}\n**Area**: ${entry.area}\n\n### Summary\n${entry.summary}\n\n### Details\n${entry.details}\n\n### Suggested Action\n${entry.suggested_action}\n\n### Metadata\n- Source: memory:self-improvement\n- Tags: ${entry.tags.join(", ")}\n- See Also: ${entry.see_also.join(", ") || "none"}\n- Pattern-Key: ${entry.pattern_key}\n- Recurrence-Count: ${entry.recurrence_count}\n- First-Seen: ${entry.first_seen}\n- Last-Seen: ${entry.last_seen}\n\n---\n`;
}

export async function syncMarkdownEntries(entries: readonly SelfImprovementEntry[], rootDir = process.cwd()): Promise<readonly string[]> {
  await ensureLearningFiles(rootDir);
  const written: string[] = [];
  for (const entry of entries) {
    const target = path.join(rootDir, ".learnings", markdownFile(entry));
    const current = await readFile(target, "utf8").catch(() => "");
    if (current.includes(`[${entry.entry_id}]`) || current.includes(`Pattern-Key: ${entry.pattern_key}`)) {
      continue;
    }
    await appendFile(target, markdownEntry(entry), { mode: 0o600 });
    written.push(target);
  }
  return written;
}

async function timedCollector(
  name: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const result = await run();
  return {
    ...result,
    collector: {
      name,
      latency_ms: Date.now() - started,
    },
  };
}

async function collectInput(options: CliOptions): Promise<Record<string, unknown>> {
  const [doctor, status, quality] = await Promise.all([
    timedCollector("doctor", () => commandJson("memory:doctor", ["--target", "ops-ready", "--mode", "full", "--plan", "--json"], options.collectorTimeoutMs)),
    timedCollector("status", () => commandJson("memory:status", ["--json"], options.collectorTimeoutMs)),
    options.skipQuality
      ? Promise.resolve({ ok: true, skipped: true, reason: "skip_quality", collector: { name: "quality", latency_ms: 0 } })
      : timedCollector("quality", () => commandJson("memory:quality", ["--json"], Math.max(options.collectorTimeoutMs, 180_000))),
  ]);
  const recentFailures = await recentRecallFailures();
  return {
    generated_at: new Date().toISOString(),
    doctor,
    status,
    quality,
    recent_recall_failures: recentFailures,
  };
}

async function main(): Promise<void> {
  const options = readOptions();
  const input = await collectInput(options);
  const now = new Date().toISOString();
  let proposalSource = "llm";
  let proposal: Record<string, unknown>;
  let entries: readonly SelfImprovementEntry[];
  if (options.deterministic) {
    proposalSource = "deterministic_fallback";
    proposal = fallbackProposal(input);
    entries = buildDeterministicEntries(input, proposal, { now, recurrenceThreshold: options.recurrencePromoteThreshold });
  } else {
    try {
      ({ proposal, entries } = await Promise.race([
        llmProposal(input, now, options.recurrencePromoteThreshold),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("llm_timeout")), options.llmTimeoutMs)),
      ]));
    } catch (error) {
      proposalSource = "deterministic_fallback";
      proposal = {
        ...fallbackProposal(input),
        llm_error: error instanceof Error ? redactText(error.message, 1200) : redactText(String(error), 1200),
      };
      entries = buildDeterministicEntries(input, proposal, { now, recurrenceThreshold: options.recurrencePromoteThreshold });
    }
  }
  const output: Record<string, unknown> = { ok: true, proposal_source: proposalSource, proposal, entries };
  if (!options.dryRun && options.writeMemory) {
    output.write = await writeEntries(entries, options);
  }
  if (!options.dryRun && options.writeMarkdown) {
    output.markdown = await syncMarkdownEntries(entries);
  }
  process.stdout.write(JSON.stringify(output, null, options.json ? 2 : 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
