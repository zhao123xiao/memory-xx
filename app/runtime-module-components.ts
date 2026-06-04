import type { RuntimeModuleSnapshot } from "./runtime-modules";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeModuleComponentStatus {
  readonly name: string;
  readonly label: string;
  readonly status: "ok" | "degraded" | "blocked" | "unknown";
  readonly detail: string;
  readonly source: string;
  readonly remediation?: string;
}

export function buildComponentStatusesFromRuntimeModules(
  snapshot: RuntimeModuleSnapshot | Record<string, unknown> | undefined
): readonly RuntimeModuleComponentStatus[] {
  const states = objectValue(snapshot?.states);
  return Object.entries(states).map(([name, raw]) => {
    const state = objectValue(raw);
    const moduleState = stringValue(state.state) || "unknown";
    const role = stringValue(state.role) || "optional";
    const source = stringValue(state.source_path) || stringValue(state.health_url) || stringValue(state.service) || "runtime module registry";
    const registryStatus: RuntimeModuleComponentStatus["status"] =
      moduleState === "enabled"
        ? "ok"
        : moduleState === "disabled"
          ? "degraded"
          : moduleState === "missing_dependency"
            ? "blocked"
            : "degraded";
    const reason = stringValue(state.reason);
    const registryComponent = {
      name,
      label: stringValue(state.label) || name,
      status: registryStatus,
      detail: reason ? `${moduleState} · ${role} · ${reason}` : `${moduleState} · ${role}`,
      source,
      remediation: moduleState === "enabled" ? undefined : stringValue(state.degraded_behavior) || undefined,
    };
    return applyWorkerStatusFile(registryComponent);
  });
}

function applyWorkerStatusFile(component: RuntimeModuleComponentStatus): RuntimeModuleComponentStatus {
  const file = workerStatusFilePath(component.name);
  if (!file || !existsSync(file)) return component;

  try {
    const status = objectValue(JSON.parse(readFileSync(file, "utf8")));
    const ok = status.ok === true;
    if (ok) {
      return {
        ...component,
        status: component.status === "blocked" ? "degraded" : component.status,
        detail: `${component.detail} · worker_status:${stringValue(status.phase) || "ok"}`,
        source: file,
      };
    }

    const phase = stringValue(status.phase) || "failed";
    const error = stringValue(status.error);
    return {
      ...component,
      status: "blocked",
      detail: `${component.detail} · worker_status:${phase}${error ? ` · ${error}` : ""}`,
      source: file,
      remediation: component.remediation || "Inspect the worker status file and restart or disable the pluggable module.",
    };
  } catch (error) {
    return {
      ...component,
      status: component.status === "ok" ? "degraded" : component.status,
      detail: `${component.detail} · worker_status_unreadable:${error instanceof Error ? error.message : String(error)}`,
      source: file,
    };
  }
}

function workerStatusFilePath(moduleName: string): string | null {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
  const configured: Record<string, string | undefined> = {
    cache_invalidation_worker: process.env.MEMORY_XX_CACHE_INVALIDATION_STATUS_FILE,
    write_ticket_worker: process.env.MEMORY_XX_WRITE_TICKET_WORKER_STATUS_FILE,
    markdown_projection: process.env.MEMORY_XX_MARKDOWN_PROJECTION_STATUS_FILE,
    memory_dreaming: process.env.MEMORY_XX_DREAM_STATUS_FILE,
    projector: process.env.MEMORY_XX_QDRANT_PROJECTOR_STATUS_FILE,
  };
  const defaults: Record<string, string> = {
    cache_invalidation_worker: join(runtimeDir, "cache-invalidation-worker.status.json"),
    write_ticket_worker: join(runtimeDir, "write-ticket-worker.status.json"),
    markdown_projection: join(runtimeDir, "markdown-projection.status.json"),
    memory_dreaming: join(runtimeDir, "dream-worker.status.json"),
    projector: join(runtimeDir, "qdrant-projector-worker.status.json"),
  };
  return configured[moduleName]?.trim() || defaults[moduleName] || null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
