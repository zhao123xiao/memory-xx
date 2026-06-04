import type { RuntimeModuleSnapshot } from "./runtime-modules";

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
    const status: RuntimeModuleComponentStatus["status"] =
      moduleState === "enabled"
        ? "ok"
        : moduleState === "disabled"
          ? "degraded"
          : moduleState === "missing_dependency"
            ? "blocked"
            : "degraded";
    const reason = stringValue(state.reason);
    return {
      name,
      label: stringValue(state.label) || name,
      status,
      detail: reason ? `${moduleState} · ${role} · ${reason}` : `${moduleState} · ${role}`,
      source,
      remediation: moduleState === "enabled" ? undefined : stringValue(state.degraded_behavior) || undefined,
    };
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
