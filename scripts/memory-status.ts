#!/usr/bin/env tsx
import "./test-harness/config.js";
import { execFileSync as nodeExecFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readConversationSourceRuntimeStatus } from "../app/conversation/conversation-source-status";
import { buildMemoryStatusTruth } from "../app/governance/memory-status-truth";
import { readRuntimeControlSettingsStateSync } from "../app/runtime-control-settings";

function wrapperUrl(): string {
  return (process.env.MEMORY_XX_WRAPPER_URL?.replace(/\/+$/, "")) ||
    `http://127.0.0.1:${process.env.MEMORY_XX_WRAPPER_PORT || "5100"}`;
}

function authToken(): string {
  return process.env.MEMORY_XX_ADMIN_TOKEN?.trim() || process.env.MEMORY_XX_API_TOKEN?.trim() || "";
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 500)}`);
  return body;
}

async function readHealth(): Promise<unknown> {
  return fetchJson(`${wrapperUrl()}/health`, {
    headers: { authorization: `Bearer ${authToken()}` },
  });
}

function readCommandJson(command: string, args: readonly string[]): { ok: boolean; body: unknown; error?: string } {
  const parseJsonFromOutput = (stdout: string): unknown => {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("json_object_not_found");
    return JSON.parse(stdout.slice(start, end + 1));
  };
  try {
    const stdout = nodeExecFileSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: "/tmp" },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, body: parseJsonFromOutput(stdout) };
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    if (stdout.trim()) {
      try {
        return { ok: false, body: parseJsonFromOutput(stdout), error: error.message };
      } catch {}
    }
    return { ok: false, body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface TimerProbeResult {
  readonly ok: boolean;
  readonly timers: string[];
  readonly error?: string;
  readonly degraded?: boolean;
}

export interface ReadTimersOptions {
  readonly runtimeDir?: string;
  readonly now?: () => number;
  readonly execFileSyncImpl?: typeof nodeExecFileSync;
  readonly staleAfterMs?: number;
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function freshTimestamp(value: unknown, now: () => number, staleAfterMs: number): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && now() - parsed <= staleAfterMs;
}

function readRuntimeTimerEvidence(input: {
  readonly runtimeDir: string;
  readonly now: () => number;
  readonly staleAfterMs: number;
}): string[] {
  const evidence: string[] = [];
  const cacheInvalidation = path.join(input.runtimeDir, "cache-invalidation-worker.status.json");
  const cacheStatus = readJsonFile(cacheInvalidation);
  if (
    cacheStatus &&
    freshTimestamp(cacheStatus.at, input.now, input.staleAfterMs) &&
    Array.isArray(cacheStatus.errors) &&
    cacheStatus.errors.length === 0
  ) {
    evidence.push(`runtime-evidence:${path.basename(cacheInvalidation)}:fresh`);
  }

  const conversationHeartbeat = path.join(input.runtimeDir, "conversation-monitor-heartbeat.json");
  const heartbeat = readJsonFile(conversationHeartbeat);
  if (
    heartbeat &&
    heartbeat.ok !== false &&
    freshTimestamp(heartbeat.updated_at, input.now, Math.max(input.staleAfterMs, 36 * 60 * 60 * 1000)) &&
    (heartbeat.last_error === null || heartbeat.last_error === undefined || heartbeat.last_error === "")
  ) {
    evidence.push(`runtime-evidence:${path.basename(conversationHeartbeat)}:fresh`);
  }

  const projectorStatus = path.join(process.cwd(), "qdrant-projector-worker.status.json");
  if (existsSync(projectorStatus)) {
    const projector = readJsonFile(projectorStatus);
    const snapshot = projector && typeof projector.snapshot === "object" && projector.snapshot !== null
      ? projector.snapshot as Record<string, unknown>
      : {};
    if (
      projector &&
      projector.phase === "running" &&
      snapshot.running === true &&
      freshTimestamp(projector.ts, input.now, input.staleAfterMs) &&
      !snapshot.lastError
    ) {
      evidence.push(`runtime-evidence:${path.basename(projectorStatus)}:fresh`);
    }
  }

  return evidence;
}

export async function readTimers(options: ReadTimersOptions = {}): Promise<TimerProbeResult> {
  const runtimeDir = options.runtimeDir ?? process.env.MEMORY_XX_RUNTIME_DIR?.trim() ?? path.join(process.cwd(), ".runtime");
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
  const execFileSyncImpl = options.execFileSyncImpl ?? nodeExecFileSync;
  try {
    const timers = execFileSyncImpl("systemctl", ["--user", "list-timers", "--all", "--no-pager"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split(/\r?\n/)
      .filter((line) => line.includes("memory-xx"));
    return { ok: true, timers };
  } catch (error) {
    const systemctlError = error instanceof Error ? error.message : String(error);
    const fallbackEvidence = readRuntimeTimerEvidence({ runtimeDir, now, staleAfterMs });
    if (fallbackEvidence.length > 0) {
      return {
        ok: true,
        timers: fallbackEvidence,
        degraded: true,
        error: `systemctl --user unavailable; using runtime evidence fallback: ${systemctlError}`
      };
    }
    return { ok: false, timers: [], error: systemctlError };
  }
}

async function readQdrantAlias(): Promise<unknown> {
  const base = process.env.MEMORY_XX_QDRANT_BASE_URL?.replace(/\/+$/, "") || "http://127.0.0.1:6333";
  const headers: Record<string, string> = {};
  if (process.env.MEMORY_XX_QDRANT_API_KEY?.trim()) headers["api-key"] = process.env.MEMORY_XX_QDRANT_API_KEY.trim();
  return fetchJson(`${base}/aliases`, { headers });
}

function summarizeHealth(body: any): Record<string, unknown> {
  return {
    status: body?.status,
    service_status: body?.service_status,
    runtime_profile: body?.runtime_profile,
    wrapper_mode: body?.wrapper_mode,
    vector: body?.vector,
    qdrant: body?.qdrant,
    redis: body?.redis,
    embedding_generation: body?.embedding_generation,
    post_commit_degraded: body?.post_commit_degraded,
  };
}

async function main(): Promise<void> {
  const runtimeOnly = process.argv.includes("--runtime-only");
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
  const [health, qdrantAlias, conversationSources] = await Promise.allSettled([
    readHealth(),
    readQdrantAlias(),
    readConversationSourceRuntimeStatus(runtimeDir),
  ]);
  const doctor = readCommandJson("npm", ["run", "memory:doctor", "--", "--target", "ops-ready", "--mode", "full", "--plan"]);
  const qdrantProjection = readCommandJson("npm", ["run", "memory:qdrant-reconcile", "--", "--max-drift=100", "--max-delete=20", "--max-upsert=100"]);
  const projector = readCommandJson("npm", ["run", "check:qdrant-projector-worker-health"]);
  const pending = readCommandJson("npm", ["run", "memory:pending", "--", "--limit=100"]);
  const pendingSafeClose = readCommandJson("npm", ["run", "memory:auto-approval-sweep", "--", "--json", "--limit=1000"]);
  const p1Gate = readCommandJson("npm", ["run", "memory:p1-gate"]);
  const timerProbe = await readTimers({ runtimeDir });
  const runtimeControls = readRuntimeControlSettingsStateSync();

  const healthBody = health.status === "fulfilled" ? health.value as any : null;
  const doctorBody = doctor.body as any;
  const pendingBody = pending.body as any;
  const pendingSafeCloseBody = pendingSafeClose.body as any;
  const pendingSafeCloseSummary = pendingSafeCloseBody?.summary ?? {};
  const safeCloseCandidateCurrent = Number(pendingSafeCloseSummary.would_reject_closed ?? 0) +
    Number(pendingSafeCloseSummary.would_reject_sensitive ?? 0) +
    Number(pendingSafeCloseSummary.would_reject_test_noise ?? 0) +
    Number(pendingSafeCloseSummary.would_reject_unknown_source ?? 0) +
    Number(pendingSafeCloseSummary.would_event_log_only ?? 0);
  const humanReviewCandidateCurrent = Number(pendingSafeCloseSummary.would_keep_pending ?? 0) +
    Number(pendingSafeCloseSummary.would_approve_default ?? 0) +
    Number(pendingSafeCloseSummary.would_approve_explicit_issue ?? 0);
  const p1Body = p1Gate.body as any;
  const truth = buildMemoryStatusTruth({
    healthOk: healthBody?.status === "ok",
    doctorOk: doctor.ok,
    doctorBlockers: Array.isArray(doctorBody?.blockers) ? doctorBody.blockers : ["doctor_blockers_unavailable"],
    qdrantProjectionOk: qdrantProjection.ok,
    qdrantProjectionBodyOk: (qdrantProjection.body as any)?.ok === true,
    projectorOk: projector.ok,
    p1GateOk: p1Body?.ok === true,
    runtimeControlsOk: runtimeControls.ok,
    candidateCurrent: Number(pendingBody?.candidate_current ?? 0),
    safeCloseCandidateCurrent: pendingSafeClose.ok ? safeCloseCandidateCurrent : Number(pendingBody?.candidate_current ?? 0),
    humanReviewCandidateCurrent: pendingSafeClose.ok ? humanReviewCandidateCurrent : 0,
    timerProbeOk: timerProbe.ok,
    runtimeOnly,
  });

  process.stdout.write(JSON.stringify({
    ok: truth.ok,
    runtime_ok: truth.runtime_ok,
    governance_ok: truth.governance_ok,
    systemd_timer_probe_ok: truth.systemd_timer_probe_ok,
    runtime_exit_ok: truth.runtime_exit_ok,
    exit_ok: truth.exit_ok,
    runtime_only: runtimeOnly,
    status_reason: truth.status_reason,
    checked_at: new Date().toISOString(),
    chain: "memory-xx Postgres -> Qdrant active alias -> wrapper/fastpath -> local agents",
    health: health.status === "fulfilled" ? summarizeHealth(health.value) : { error: String(health.reason) },
    issues: [
      ...(((healthBody as any)?.issues ?? []) as unknown[]),
      ...((((qdrantProjection.body as any)?.issues ?? []) as unknown[])),
    ],
    repair_summary: (healthBody as any)?.repair_summary ?? null,
    doctor: doctor.body,
    qdrant_projection: qdrantProjection.body,
    projector: projector.body,
    pending: pending.body,
    pending_safe_close: pendingSafeClose.body,
    governance_backlog: {
      candidate_current: Number(pendingBody?.candidate_current ?? 0),
      safe_close_candidate_current: pendingSafeClose.ok ? safeCloseCandidateCurrent : null,
      human_review_candidate_current: pendingSafeClose.ok ? humanReviewCandidateCurrent : null,
      safe_close_probe_ok: pendingSafeClose.ok,
      safe_close_probe_error: pendingSafeClose.error,
    },
    p1_gate: p1Gate.body,
    runtime_controls: {
      ok: runtimeControls.ok,
      reason: runtimeControls.reason,
      path: runtimeControls.path,
      error: runtimeControls.error,
      values_count: Object.keys(runtimeControls.settings.values).length,
      pending_restart_count: Object.keys(runtimeControls.settings.pending_restart).length,
    },
    conversation_sources: conversationSources.status === "fulfilled"
      ? conversationSources.value
      : { ok: false, error: String(conversationSources.reason) },
    timers: timerProbe.timers,
    timer_probe: {
      ok: timerProbe.ok,
      error: timerProbe.error,
    },
    qdrant_alias: qdrantAlias.status === "fulfilled" ? qdrantAlias.value : { error: String(qdrantAlias.reason) },
    legacy: {
      markdown_sqlite_role: "retired legacy assets; not audit mirrors or source-of-truth views",
      agent_legacy_memory_search: "agent-specific legacy memory surfaces are not memory-xx health checks; use memory_xx_recall and memory_xx_write",
    },
  }, null, 2) + "\n");
  process.exitCode = truth.exit_ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
