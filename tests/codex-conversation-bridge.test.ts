import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendCodexConversationEvent,
  buildCodexConversationEvent,
} from "../app/conversation/codex-jsonl-bridge";

test("buildCodexConversationEvent applies default Codex scope", () => {
  const event = buildCodexConversationEvent({
    role: "user",
    content: "请记住：默认 scope 应该进入 memory-xx project。",
  }, new Date("2026-05-28T00:00:00.000Z"));

  assert.equal(event.conversation_id, "codex-local");
  assert.equal(event.session_id, "codex-2026-05-28");
  assert.equal(event.agent_id, "codex");
  assert.deepEqual(event.scope_context, {
    project_ids: ["memory-xx"],
    user_id: "current-instance-owner",
    workspace_id: "current-instance",
  });
  assert.equal(event.metadata.bridge, "codex-jsonl-bridge");
});

test("appendCodexConversationEvent writes one JSONL event", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-test-"));
  try {
    const file = path.join(dir, "conversation-events", "codex.jsonl");
    await appendCodexConversationEvent(file, {
      role: "assistant",
      content: "已记录为 JSONL。",
      conversation_id: "conv-a",
      session_id: "session-a",
      turn_id: "assistant-1",
      scope_context: { project_ids: ["project-a"] },
    });
    const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/u);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!);
    assert.equal(event.conversation_id, "conv-a");
    assert.equal(event.session_id, "session-a");
    assert.equal(event.turn_id, "assistant-1");
    assert.equal(event.role, "assistant");
    assert.deepEqual(event.scope_context, { project_ids: ["project-a"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
