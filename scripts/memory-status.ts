#!/usr/bin/env tsx
import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readConversationSourceRuntimeStatus } from "../app/conversation/conversation-source-status";
import { buildMemoryStatusTruth } from "../app/governance/memory-status-truth";

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
    const stdout = execFileSync(command, args, {
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

function readTimers(): { ok: boolean; timers: string[]; error?: string } {
  try {
    const timers = execFileSync("systemctl", ["--user", "list-timers", "--all", "--no-pager"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split(/\r?\n/)
      .filter((line) => line.includes("memory-xx"));
    return { ok: true, timers };
  } catch (error) {
    return { ok: false, timers: [], error: error instanceof Error ? error.message : String(error) };
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
  const p1Gate = readCommandJson("npm", ["run", "memory:p1-gate"]);
  const timerProbe = readTimers();

  const healthBody = health.status === "fulfilled" ? health.value as any : null;
  const doctorBody = doctor.body as any;
  const pendingBody = pending.body as any;
  const p1Body = p1Gate.body as any;
  const truth = buildMemoryStatusTruth({
    healthOk: healthBody?.status === "ok",
    doctorOk: doctor.ok,
    doctorBlockers: Array.isArray(doctorBody?.blockers) ? doctorBody.blockers : ["doctor_blockers_unavailable"],
    qdrantProjectionOk: qdrantProjection.ok,
    qdrantProjectionBodyOk: (qdrantProjection.body as any)?.ok === true,
    projectorOk: projector.ok,
    p1GateOk: p1Body?.ok === true,
    candidateCurrent: Number(pendingBody?.candidate_current ?? 0),
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
    p1_gate: p1Gate.body,
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
