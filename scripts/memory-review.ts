#!/usr/bin/env tsx
import "./test-harness/config.js";
import { randomUUID } from "node:crypto";

import { requireCliPermission } from "../app/server/permissions.js";

function wrapperUrl(): string {
  return (process.env.MEMORY_V2_WRAPPER_URL?.replace(/\/+$/, "")) ||
    `http://127.0.0.1:${process.env.MEMORY_V2_WRAPPER_PORT || "5100"}`;
}

function authToken(): string {
  return process.env.MEMORY_V2_ADMIN_TOKEN?.trim() || process.env.MEMORY_V2_CLI_TOKEN?.trim() || "";
}

async function postJson(pathname: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${wrapperUrl()}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 500)}`);
  return parsed;
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_apply");
  const action = process.argv[2];
  const memoryId = process.argv[3];
  if (!["approve", "reject", "archive"].includes(action ?? "")) {
    throw new Error("usage: npm run memory:review -- <approve|reject|archive> <memory_id> [reason]");
  }
  if (!memoryId) throw new Error("memory_id is required");
  const reason = process.argv.slice(4).join(" ").trim();
  const result = await postJson(`/api/memory/v2/review/memories/${encodeURIComponent(memoryId)}/${action}`, {
    requestId: randomUUID(),
    actorId: "memory:review",
    ...(reason ? { reason } : {}),
  });
  process.stdout.write(JSON.stringify({ ok: true, action, memory_id: memoryId, result }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
