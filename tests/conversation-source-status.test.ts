import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readConversationSourceRuntimeStatus } from "../app/conversation/conversation-source-status";

test("conversation source status summarizes worker heartbeat adapters", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-source-status-"));
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "conversation-monitor-heartbeat.json"), JSON.stringify({
    ok: true,
    updated_at: "2026-06-02T07:00:00.000Z",
    source_cursor_path: ".runtime/conversation-sources.cursor.json",
    source_files: ["/tmp/codex.jsonl", "/tmp/claude.jsonl"],
    source_events_posted: 3,
    source_skipped: 4,
    source_skipped_existing_files: 1,
    source_adapters: [
      {
        adapter: "codex_session",
        roots: ["/tmp/codex"],
        files: 1,
        events: 2,
        skipped: 1,
        last_event_at: "2026-06-02T06:59:00.000Z",
      },
      {
        adapter: "claude_code_session",
        roots: ["/tmp/claude"],
        files: 1,
        events: 1,
        skipped: 3,
        last_event_at: "2026-06-02T06:58:00.000Z",
      },
    ],
  }), "utf8");

  const status = await readConversationSourceRuntimeStatus(runtimeDir);

  assert.equal(status.ok, true);
  assert.equal(status.heartbeat_updated_at, "2026-06-02T07:00:00.000Z");
  assert.equal(status.source_file_count, 2);
  assert.equal(status.source_events_posted, 3);
  assert.equal(status.adapters.length, 2);
  assert.equal(status.adapters[0]?.adapter, "codex_session");
  assert.equal(status.adapters[0]?.last_seen, "2026-06-02T07:00:00.000Z");
});

test("conversation source status reports missing heartbeat without throwing", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-source-status-missing-"));

  const status = await readConversationSourceRuntimeStatus(runtimeDir);

  assert.equal(status.ok, false);
  assert.equal(status.adapters.length, 0);
  assert.match(status.error ?? "", /ENOENT/u);
});
