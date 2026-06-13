// Skill: Memory Health Check — audit + metrics snapshot in one call.

import type { SkillDefinition, SkillExecutor } from "../types";

export const HEALTH_CHECK_SKILL: SkillDefinition = {
  id: "health_check",
  name: "Memory Health Check",
  description: "Run a comprehensive health check: service status + consistency audit + metrics snapshot.",
  category: "analysis",
  sideEffects: "read",
  scopePolicy: "global_required",
  requiredPermissions: [{ action: "memory:read" }],
  parameters: [
    { name: "include_records", type: "boolean", description: "Include record snapshot in audit", default: false },
    { name: "dry_run_repair", type: "boolean", description: "Preview repairs without applying", default: true },
  ],
};

export function createHealthCheckExecutor(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): SkillExecutor {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return async (params) => {
    const [healthResp, auditResp, metricsResp] = await Promise.all([
      fetch(`${base}/health`, { headers }),
      fetch(`${base}/api/memory/xx/orchestrator/audit-memory-consistency`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ include_records: params.include_records === true }),
      }),
      fetch(`${base}/metrics`, { headers }),
    ]);

    const health = healthResp.ok ? await healthResp.json() : { error: `HTTP ${healthResp.status}` };
    const audit = auditResp.ok ? await auditResp.json() : { error: `HTTP ${auditResp.status}` };
    const metrics = metricsResp.ok ? await metricsResp.json() : { error: `HTTP ${metricsResp.status}` };

    const issues = (audit as { findings?: unknown[] }).findings?.length ?? 0;
    let repair: unknown = null;
    if (issues > 0 && params.dry_run_repair !== false) {
      const repairResp = await fetch(`${base}/api/memory/xx/orchestrator/repair-memory-consistency`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true }),
      });
      repair = repairResp.ok ? await repairResp.json() : { error: `HTTP ${repairResp.status}` };
    }

    return {
      success: true,
      data: { health, audit, metrics, repair_preview: repair },
    };
  };
}
