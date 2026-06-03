// Skill: Memory Cleanup — tombstone old/archived memories and compact storage.

import type { SkillDefinition, SkillExecutor } from "../types";

export const MEMORY_CLEANUP_SKILL: SkillDefinition = {
  id: "memory_cleanup",
  name: "Memory Cleanup",
  description: "Identify and clean up stale memories: audit consistency, dry-run repairs, and report cleanup plan.",
  category: "maintenance",
  sideEffects: "maintenance",
  scopePolicy: "global_required",
  requiredPermissions: [{ action: "memory:write" }],
  parameters: [
    { name: "apply_repairs", type: "boolean", description: "Actually apply repairs (default: false = dry run)", default: false },
    { name: "include_records", type: "boolean", description: "Include full record details in report", default: false },
  ],
};

export function createMemoryCleanupExecutor(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): SkillExecutor {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return async (params) => {
    const dryRun = params.apply_repairs !== true;

    // Step 1: Audit
    const auditResp = await fetch(`${base}/api/memory/v2/orchestrator/audit-memory-consistency`, {
      method: "POST",
      headers,
      body: JSON.stringify({ include_records: params.include_records === true }),
    });

    if (!auditResp.ok) {
      return { success: false, error: `Audit failed: HTTP ${auditResp.status}` };
    }

    const audit = (await auditResp.json()) as {
      ok: boolean;
      findings: { code: string; severity: string; memoryId?: string; details: string }[];
      counts: Record<string, number>;
    };

    // Step 2: Repair if issues found
    let repair: unknown = null;
    if (!audit.ok) {
      const repairResp = await fetch(`${base}/api/memory/v2/orchestrator/repair-memory-consistency`, {
        method: "POST",
        headers,
        body: JSON.stringify({ dry_run: dryRun }),
      });
      repair = repairResp.ok ? await repairResp.json() : { error: `HTTP ${repairResp.status}` };
    }

    return {
      success: true,
      data: {
        audit,
        repair,
        dry_run: dryRun,
        summary: {
          total_findings: audit.findings.length,
          by_severity: audit.findings.reduce<Record<string, number>>((acc, f) => {
            acc[f.severity] = (acc[f.severity] ?? 0) + 1;
            return acc;
          }, {}),
        },
      },
    };
  };
}
