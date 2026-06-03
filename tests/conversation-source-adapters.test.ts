import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseConversationSourceLine,
  scanConversationSources,
} from "../app/conversation/session-source-adapters";

test("codex session adapter maps user messages and skips developer/tool noise", () => {
  const file = "/tmp/codex/sessions/run.jsonl";
  const user = parseConversationSourceLine("codex_session", JSON.stringify({
    timestamp: "2026-06-02T01:02:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "请记住：Codex 真实采集测试。" }],
    },
  }), { file, offset: 12, lineNumber: 1 });
  assert.equal(user?.role, "user");
  assert.equal(user?.source, "codex-session-tail");
  assert.equal(user?.agent_id, "codex");
  assert.equal(user?.content, "请记住：Codex 真实采集测试。");
  assert.equal(user?.metadata.source_adapter, "codex_session");
  assert.equal(user?.metadata.source_file, file);
  assert.equal(user?.metadata.source_offset, 12);

  const developer = parseConversationSourceLine("codex_session", JSON.stringify({
    timestamp: "2026-06-02T01:02:04.000Z",
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system rules" }] },
  }), { file, offset: 44, lineNumber: 2 });
  assert.equal(developer, null);

  const tool = parseConversationSourceLine("codex_session", JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", name: "shell_command" },
  }), { file, offset: 55, lineNumber: 3 });
  assert.equal(tool, null);
});

test("claude code adapter maps message records and skips tool/thinking records", () => {
  const file = "/tmp/claude/projects/session.jsonl";
  const event = parseConversationSourceLine("claude_code_session", JSON.stringify({
    type: "user",
    uuid: "u-1",
    timestamp: "2026-06-02T02:00:00.000Z",
    sessionId: "claude-session-1",
    cwd: "/workspace/local/services/memory-xx",
    message: { role: "user", content: "请记住：Claude Code 入口已接入。" },
  }), { file, offset: 0, lineNumber: 1 });
  assert.equal(event?.role, "user");
  assert.equal(event?.source, "claude-code-session-tail");
  assert.equal(event?.agent_id, "claude-code");
  assert.equal(event?.session_id, "claude-session-1");
  assert.equal(event?.metadata.source_message_id, "u-1");

  const thinking = parseConversationSourceLine("claude_code_session", JSON.stringify({
    type: "assistant",
    uuid: "a-1",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "hidden chain" }],
    },
  }), { file, offset: 100, lineNumber: 2 });
  assert.equal(thinking, null);
});

test("openclaw adapter maps real messages and skips dreaming promotion or failed empty turns", () => {
  const file = "/workspace/local/.openclaw/agents/main/sessions/session.jsonl";
  const session = parseConversationSourceLine("openclaw_session", JSON.stringify({
    type: "session",
    id: "openclaw-session-1",
    timestamp: "2026-06-02T03:00:00.000Z",
    cwd: "/workspace/local",
  }), { file, offset: 0, lineNumber: 1 });
  assert.equal(session, null);

  const event = parseConversationSourceLine("openclaw_session", JSON.stringify({
    type: "message",
    id: "m-1",
    timestamp: "2026-06-02T03:01:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "请记住：OpenClaw 真实会话入口接入。" }],
    },
  }), { file, offset: 10, lineNumber: 2, sessionId: "openclaw-session-1" });
  assert.equal(event?.role, "user");
  assert.equal(event?.source, "openclaw-session-tail");
  assert.equal(event?.agent_id, "openclaw-main");
  assert.equal(event?.session_id, "openclaw-session-1");

  const promotion = parseConversationSourceLine("openclaw_session", JSON.stringify({
    type: "message",
    id: "m-2",
    message: {
      role: "user",
      content: [{ type: "text", text: "[cron:abc Memory Dreaming Promotion] __openclaw_memory_core_short_term_promotion_dream__" }],
    },
  }), { file, offset: 20, lineNumber: 3, sessionId: "openclaw-session-1" });
  assert.equal(promotion, null);

  const failed = parseConversationSourceLine("openclaw_session", JSON.stringify({
    type: "message",
    id: "m-3",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
      stopReason: "error",
    },
  }), { file, offset: 30, lineNumber: 4, sessionId: "openclaw-session-1" });
  assert.equal(failed, null);
});

test("source scanner uses cursor, skips existing files by default, and reads appended lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-source-adapter-"));
  try {
    const root = path.join(dir, "codex", "sessions");
    const file = path.join(root, "run.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(file, `${JSON.stringify({
      timestamp: "2026-06-02T01:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "历史内容不应首次回灌。" }] },
    })}\n`, "utf8");
    const cursorPath = path.join(dir, "cursor.json");
    const first = await scanConversationSources({
      adapters: [{ adapter: "codex_session", roots: [root] }],
      cursorPath,
      readExisting: false,
    });
    assert.equal(first.events.length, 0);
    assert.equal(first.skipped_existing_files, 1);

    await writeFile(file, `${await readFile(file, "utf8")}${JSON.stringify({
      timestamp: "2026-06-02T01:01:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "新增内容应该被采集。" }] },
    })}\n`, "utf8");
    const second = await scanConversationSources({
      adapters: [{ adapter: "codex_session", roots: [root] }],
      cursorPath,
      readExisting: false,
    });
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]?.content, "新增内容应该被采集。");

    const third = await scanConversationSources({
      adapters: [{ adapter: "codex_session", roots: [root] }],
      cursorPath,
      readExisting: false,
    });
    assert.equal(third.events.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source scanner can explicitly backfill temp roots for tests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-source-backfill-"));
  try {
    const root = path.join(dir, "openclaw", "sessions");
    const file = path.join(root, "session.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(file, [
      JSON.stringify({ type: "session", id: "openclaw-backfill", timestamp: "2026-06-02T03:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "m-1",
        timestamp: "2026-06-02T03:01:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "backfill 测试内容。" }] },
      }),
      "",
    ].join("\n"), "utf8");
    const result = await scanConversationSources({
      adapters: [{ adapter: "openclaw_session", roots: [root] }],
      cursorPath: path.join(dir, "cursor.json"),
      readExisting: true,
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.conversation_id, "openclaw-openclaw-backfill");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
