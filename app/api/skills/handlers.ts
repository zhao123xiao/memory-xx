import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillRegistry } from "../../skills/skill-registry";
import type { SkillPermission } from "../../skills/types";
import { parseJsonBody } from "../../server/body";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonBodyErrorStatus(message: string): number {
  if (message === "body_read_timeout") return 408;
  if (message === "body_too_large") return 413;
  if (message === "invalid_json_body") return 400;
  return 500;
}

export async function handleListSkills(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SkillRegistry,
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "请求方法不允许" });
    return;
  }

  const skills = registry.list();
  sendJson(res, 200, { ok: true, count: skills.length, skills });
}

export async function handleExecuteSkill(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SkillRegistry,
  permissions: readonly SkillPermission[] = [],
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "请求方法不允许" });
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const payload = isPlainObject(body) ? body : {};
    const skillId = typeof payload.skill_id === "string"
      ? payload.skill_id.trim()
      : typeof payload.id === "string"
        ? payload.id.trim()
        : "";
    const paramsSource = isPlainObject(payload.params) ? "params" : "flat_payload";
    const params = isPlainObject(payload.params)
      ? payload.params
      : Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "skill_id" && key !== "id" && key !== "params")
      );

    if (!skillId) {
      sendJson(res, 400, { ok: false, error: "缺少必填字段：skill_id（技能 ID）" });
      return;
    }

    const scope = typeof params.scope_type === "string" && typeof params.scope_id === "string"
      ? { type: params.scope_type, id: params.scope_id }
      : null;
    const result = await registry.execute(skillId, params, permissions, { scope });
    sendJson(res, result.success ? 200 : 400, { ok: result.success, params_source: paramsSource, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, jsonBodyErrorStatus(message), { ok: false, error: message });
  }
}
