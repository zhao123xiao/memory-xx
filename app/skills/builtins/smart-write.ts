
// Skill: Smart Write — extract canonical memory before writing.

import type { SkillDefinition, SkillExecutor } from "../types";
import { DEFAULT_AGENT_ID } from "../../shared";

export const SMART_WRITE_SKILL: SkillDefinition = {
  id: "smart_write",
  name: "Smart Write",
  description: "Extract canonical memories from user text and write them through memory-xx intelligence.",
  category: "write",
  sideEffects: "write",
  scopePolicy: "explicit_scope_required",
  requiredPermissions: [{ action: "memory:write" }],
  parameters: [
    { name: "content", type: "string", description: "Raw user text or memory content", required: true },
    { name: "scope_type", type: "string", description: "Scope type", default: "user" },
    { name: "scope_id", type: "string", description: "Scope id" },
    { name: "user_id", type: "string", description: "User context", default: "current-instance-owner" },
    { name: "workspace_id", type: "string", description: "Workspace context", default: "current-instance" },
    { name: "author", type: "string", description: "Author identifier", default: DEFAULT_AGENT_ID },
    { name: "mode", type: "string", description: "draft, write, or auto_approve", default: "write" },
  ],
};

export function createSmartWriteExecutor(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): SkillExecutor {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers.Authorization = "Bearer " + deps.apiToken;

  return async (params) => {
    const userId = String(params.user_id ?? "current-instance-owner");
    const scopeType = String(params.scope_type ?? "user");
    const scopeId = String(params.scope_id ?? userId);
    const res = await fetch(base + "/api/memory/xx/intelligence/smart-write", {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: String(params.content),
        agent_id: String(params.author ?? DEFAULT_AGENT_ID),
        user_id: userId,
        workspace_id: String(params.workspace_id ?? "current-instance"),
        scope_hint: { scope_type: scopeType, scope_id: scopeId },
        mode: String(params.mode ?? "write"),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: "智能写入失败：HTTP " + res.status + ": " + text.slice(0, 200) };
    }

    return {
      success: true,
      data: await res.json(),
    };
  };
}
