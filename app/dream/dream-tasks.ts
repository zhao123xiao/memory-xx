// Dream tasks — concrete maintenance tasks for the dream worker.

import type { DreamTask, DreamTaskResult } from "./dream-worker";
import { createLogger } from "../shared/logger";

const log = createLogger("dream-tasks");

function dreamFetch(url: string, init: RequestInit = {}, timeoutMs = Number.parseInt(process.env.MEMORY_V2_DREAM_TASK_TIMEOUT_MS ?? "5000", 10)): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// ─── Consistency Audit Task ────────────────────────────────────────────────────

export function createConsistencyAuditTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "consistency_audit",
    name: "Consistency Audit",
    description: "Audit memory database for consistency issues (orphaned records, missing events)",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const res = await dreamFetch(`${base}/api/memory/v2/orchestrator/audit-memory-consistency`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include_records: false }),
      });
      if (!res.ok) {
        return {
          task_id: this.id,
          task_name: this.name,
          status: "failed",
          duration_ms: Date.now() - start,
          summary: `Audit request failed: HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        ok: boolean;
        findings: { code: string; severity: string }[];
        counts: Record<string, number>;
      };
      return {
        task_id: this.id,
        task_name: this.name,
        status: "completed",
        duration_ms: Date.now() - start,
        summary: data.ok
          ? `Consistency OK (${JSON.stringify(data.counts)} records checked)`
          : `Found ${data.findings.length} issues: ${data.findings.map((f) => f.code).join(", ")}`,
        details: data,
      };
    },
  };
}

// ─── Auto Repair Task ──────────────────────────────────────────────────────────

export function createAutoRepairTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly dryRun?: boolean;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "auto_repair",
    name: "Auto Repair",
    description: "Automatically repair consistency issues found during audit",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const res = await dreamFetch(`${base}/api/memory/v2/orchestrator/repair-memory-consistency`, {
        method: "POST",
        headers,
        body: JSON.stringify({ dry_run: deps.dryRun ?? true }),
      });
      if (!res.ok) {
        return {
          task_id: this.id,
          task_name: this.name,
          status: "failed",
          duration_ms: Date.now() - start,
          summary: `Repair request failed: HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        repairs: { code: string; action: string }[];
        dry_run: boolean;
      };
      return {
        task_id: this.id,
        task_name: this.name,
        status: "completed",
        duration_ms: Date.now() - start,
        summary: data.repairs.length > 0
          ? `${data.dry_run ? "Would repair" : "Repaired"} ${data.repairs.length} issues: ${data.repairs.map((r) => r.code).join(", ")}`
          : "No repairs needed",
        details: data,
      };
    },
  };
}

// ─── Memory Statistics Task ────────────────────────────────────────────────────

export function createMemoryStatsTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "memory_stats",
    name: "Memory Statistics",
    description: "Collect memory service statistics and health snapshot",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const [healthResp, metricsResp] = await Promise.all([
        dreamFetch(`${base}/health`, { headers }).catch(() => null),
        dreamFetch(`${base}/metrics`, { headers }).catch(() => null),
      ]);

      const health = healthResp?.ok ? await healthResp.json() : { error: "unavailable" };
      const metrics = metricsResp?.ok ? await metricsResp.json() : { error: "unavailable" };

      return {
        task_id: this.id,
        task_name: this.name,
        status: "completed",
        duration_ms: Date.now() - start,
        summary: `Service status: ${(health as { status?: string }).status ?? "unknown"}`,
        details: { health, metrics },
      };
    },
  };
}

// ─── Embedding Retry Task ──────────────────────────────────────────────────────

export function createEmbeddingRetryTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "embedding_retry",
    name: "Embedding Retry",
    description: "Retry failed embedding generations from the dead letter queue",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      return {
        task_id: this.id,
        task_name: this.name,
        status: "skipped",
        duration_ms: Date.now() - start,
        summary: "Embedding retry endpoint is not exposed; use qdrant replay/repair workers for projection recovery.",
        details: { endpoint_removed: true },
      };
    },
  };
}
