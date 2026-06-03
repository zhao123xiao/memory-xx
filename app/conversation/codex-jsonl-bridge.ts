import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { JsonObject } from "../shared";

export type CodexConversationRole = "system" | "user" | "assistant" | "tool";

export interface CodexConversationBridgeInput {
  readonly role: CodexConversationRole;
  readonly content: string;
  readonly conversation_id?: string;
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly agent_id?: string;
  readonly source?: string;
  readonly scope_context?: JsonObject;
  readonly observed_at?: string;
  readonly metadata?: JsonObject;
}

export interface CodexConversationEvent {
  readonly conversation_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly role: CodexConversationRole;
  readonly content: string;
  readonly agent_id: string;
  readonly source: string;
  readonly scope_context: JsonObject;
  readonly observed_at: string;
  readonly metadata: JsonObject;
}

function readString(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultSessionId(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function defaultScopeContext(): JsonObject {
  return {
    project_ids: [(process.env.MEMORY_V2_CONVERSATION_DEFAULT_PROJECT_ID ?? "memory-xx").trim() || "memory-xx"],
    user_id: process.env.MEMORY_V2_CONVERSATION_DEFAULT_USER_ID?.trim() || "current-instance-owner",
    workspace_id: process.env.MEMORY_V2_CONVERSATION_DEFAULT_WORKSPACE_ID?.trim() || "current-instance",
  };
}

export function defaultCodexSpoolPath(cwd = process.cwd()): string {
  const explicit = process.env.MEMORY_V2_CODEX_CONVERSATION_SPOOL_PATH?.trim();
  if (explicit) return path.resolve(cwd, explicit);
  const runtimeDir = process.env.MEMORY_V2_RUNTIME_DIR?.trim() || path.join(cwd, ".runtime");
  return path.resolve(cwd, runtimeDir, "conversation-events", "codex.jsonl");
}

export function buildCodexConversationEvent(input: CodexConversationBridgeInput, now = new Date()): CodexConversationEvent {
  const content = input.content.trim();
  if (!content) {
    throw new Error("content_required");
  }
  const conversationId = readString(
    input.conversation_id ?? process.env.CODEX_CONVERSATION_ID ?? process.env.MEMORY_V2_CONVERSATION_ID,
    "codex-local"
  );
  const sessionId = readString(
    input.session_id ?? process.env.CODEX_SESSION_ID ?? process.env.MEMORY_V2_CONVERSATION_SESSION_ID,
    `codex-${defaultSessionId(now)}`
  );
  const contentHash = sha256(content);
  return {
    conversation_id: conversationId,
    session_id: sessionId,
    turn_id: readString(input.turn_id, `${input.role}-${now.getTime()}-${contentHash.slice(0, 10)}`),
    role: input.role,
    content,
    agent_id: readString(input.agent_id, "codex"),
    source: readString(input.source, "codex-jsonl-bridge"),
    scope_context: input.scope_context ?? defaultScopeContext(),
    observed_at: input.observed_at ?? now.toISOString(),
    metadata: {
      bridge: "codex-jsonl-bridge",
      bridge_event_id: randomUUID(),
      ...(input.metadata ?? {}),
    },
  };
}

export async function appendCodexConversationEvent(
  filePath: string,
  input: CodexConversationBridgeInput,
): Promise<CodexConversationEvent> {
  const event = buildCodexConversationEvent(input);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}
