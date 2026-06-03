#!/usr/bin/env tsx
import "./test-harness/config.js";
import { readFile } from "node:fs/promises";

import {
  appendCodexConversationEvent,
  defaultCodexSpoolPath,
  type CodexConversationBridgeInput,
  type CodexConversationRole,
} from "../app/conversation/codex-jsonl-bridge";
import type { JsonObject } from "../app/shared";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseRole(value: string | undefined): CodexConversationRole {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value;
  if (!value) return "user";
  throw new Error(`invalid_role:${value}`);
}

function parseJsonObject(raw: string | undefined, fallback: JsonObject = {}): JsonObject {
  if (!raw?.trim()) return fallback;
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : fallback;
}

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildInputFromArgs(content: string): CodexConversationBridgeInput {
  const scopeContextArg = arg("scope-context");
  return {
    role: parseRole(arg("role")),
    content,
    conversation_id: arg("conversation-id"),
    session_id: arg("session-id"),
    turn_id: arg("turn-id"),
    agent_id: arg("agent-id"),
    source: arg("source"),
    ...(scopeContextArg ? { scope_context: parseJsonObject(scopeContextArg) } : {}),
    metadata: parseJsonObject(arg("metadata")),
  };
}

async function main(): Promise<void> {
  const filePath = arg("path") || defaultCodexSpoolPath();
  const raw = await stdinText();
  const jsonInput = flag("json") && raw.trim()
    ? JSON.parse(raw) as Partial<CodexConversationBridgeInput>
    : null;
  const content = jsonInput?.content || arg("content") || raw.trim();
  const input = jsonInput
    ? { ...jsonInput, role: parseRole(jsonInput.role), content } as CodexConversationBridgeInput
    : buildInputFromArgs(content);
  const event = await appendCodexConversationEvent(filePath, input);
  console.log(JSON.stringify({ ok: true, path: filePath, event }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
