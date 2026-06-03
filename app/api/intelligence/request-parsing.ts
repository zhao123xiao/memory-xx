import { createHash } from "node:crypto";

import type { ConversationMessageInput, ExtractionMode } from "../../intelligence/types";
import { ScopeType, type JsonObject } from "../../shared";
import { stableStringify } from "../../shared/command-serialization";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonObject(value: unknown): JsonObject {
  return isPlainObject(value) ? value as JsonObject : {};
}

export function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function readMessages(value: unknown): ConversationMessageInput[] {
  if (!Array.isArray(value)) return [];
  const roles = new Set(["system", "user", "assistant", "tool"]);
  const messages: ConversationMessageInput[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const role = readString(item.role);
    const content = readString(item.content);
    if (!roles.has(role) || !content) continue;
    messages.push({
      role: role as ConversationMessageInput["role"],
      content,
      ...(readString(item.created_at ?? item.createdAt) ? { created_at: readString(item.created_at ?? item.createdAt) } : {}),
      ...(readString(item.name) ? { name: readString(item.name) } : {}),
    });
  }
  return messages;
}

export function parseMode(value: unknown): ExtractionMode {
  return value === "draft" || value === "write" || value === "auto_approve" ? value : "write";
}

export function resolveScopeType(raw: string): ScopeType {
  const map: Record<string, ScopeType> = {
    personal: ScopeType.User,
    shared: ScopeType.Workspace,
    execution: ScopeType.Run,
    user: ScopeType.User,
    workspace: ScopeType.Workspace,
    run: ScopeType.Run,
    project: ScopeType.Project,
    global: ScopeType.Global,
    task: ScopeType.Task,
  };
  const resolved = map[raw.toLowerCase()];
  if (!resolved) {
    throw Object.assign(new Error("invalid_scope_type"), { status: 400 });
  }
  if (resolved === ScopeType.Run || resolved === ScopeType.Task) {
    throw Object.assign(new Error("runtime_scope_not_supported_for_write"), { status: 400 });
  }
  return resolved;
}

export function parseScopeHint(payload: Record<string, unknown>): { scope_type: string; scope_id: string } | undefined {
  const hint = isPlainObject(payload.scope_hint) ? payload.scope_hint : undefined;
  const scopeType = readString(hint?.scope_type ?? hint?.scopeType ?? payload.scope_type ?? payload.scopeType);
  const scopeId = readString(hint?.scope_id ?? hint?.scopeId ?? payload.scope_id ?? payload.scopeId);
  return scopeType && scopeId ? { scope_type: scopeType, scope_id: scopeId } : undefined;
}

export function payloadFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function samePayload(left: unknown, right: Record<string, unknown>): boolean {
  if (!isPlainObject(left)) return false;
  return payloadFingerprint(left) === payloadFingerprint(right);
}
