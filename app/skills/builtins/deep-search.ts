// Skill: Deep Search — search, re-rank, and summarize memories in one call.

import type { SkillDefinition, SkillExecutor } from "../types";

export const DEEP_SEARCH_SKILL: SkillDefinition = {
  id: "deep_search",
  name: "Deep Search",
  description: "Search memories with automatic summarization. Combines recall + summarization into a single operation.",
  category: "recall",
  sideEffects: "read",
  scopePolicy: "explicit_scope_required",
  requiredPermissions: [{ action: "memory:read" }],
  parameters: [
    { name: "query", type: "string", description: "Natural language search query", required: true },
    { name: "max_items", type: "number", description: "Max items to include in summary (default: 5)", default: 5 },
    { name: "user_id", type: "string", description: "User context for scope resolution" },
    { name: "workspace_id", type: "string", description: "Workspace context for scope resolution" },
  ],
};

export function createDeepSearchExecutor(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): SkillExecutor {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return async (params) => {
    const body = {
      request: {
        query: String(params.query),
        scope_context: {
          user_id: String(params.user_id ?? "current-instance-owner"),
          workspace_id: String(params.workspace_id ?? "current-instance"),
          include_global: true,
        },
      },
      max_items: Number(params.max_items ?? 5),
    };

    const res = await fetch(`${base}/api/memory/xx/orchestrator/summarize-memory`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    return { success: true, data: await res.json() };
  };
}
