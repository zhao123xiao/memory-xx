import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("conversation source dry-run CLI scans configured roots without advancing cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-conversation-source-cli-"));
  try {
    const codexRoot = path.join(dir, "codex", "sessions");
    const claudeRoot = path.join(dir, "claude", "projects");
    const openclawRoot = path.join(dir, "openclaw", "sessions");
    await mkdir(codexRoot, { recursive: true });
    await mkdir(claudeRoot, { recursive: true });
    await mkdir(openclawRoot, { recursive: true });
    await writeFile(path.join(codexRoot, "run.jsonl"), `${JSON.stringify({
      timestamp: "2026-06-02T01:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex dry-run 入口测试。" }] },
    })}\n`, "utf8");

    const cursor = path.join(dir, "cursor.json");
    const stdout = execFileSync("npm", [
      "run",
      "memory:conversation-sources",
      "--",
      "scan",
      "--dry-run",
      "--backfill",
      "--json",
      `--cursor=${cursor}`,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        MEMORY_XX_CODEX_SESSION_ROOTS: codexRoot,
        MEMORY_XX_CLAUDE_SESSION_ROOTS: claudeRoot,
        MEMORY_XX_OPENCLAW_SESSION_ROOTS: openclawRoot,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    const jsonStart = stdout.indexOf("{");
    const body = JSON.parse(stdout.slice(jsonStart)) as {
      source_events: number;
      sample_events: Array<{ source: string; content_preview: string }>;
    };
    assert.equal(body.source_events, 1);
    assert.equal(body.sample_events[0]?.source, "codex-session-tail");
    assert.match(body.sample_events[0]?.content_preview ?? "", /Codex dry-run/u);
    assert.equal(existsSync(cursor), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation monitor does not advance spool cursor when wrapper post fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-conversation-worker-cursor-"));
  try {
    const spoolDir = path.join(dir, "conversation-events");
    const controlsPath = path.join(dir, "conversation-monitor.json");
    const spoolPath = path.join(spoolDir, "codex.jsonl");
    const cursorPath = path.join(spoolDir, ".cursor.json");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(controlsPath, JSON.stringify({
      conversation_monitor: true,
      conversation_auto_extract: false,
    }), "utf8");
    await writeFile(spoolPath, `${JSON.stringify({
      conversation_id: "offline-wrapper-fail",
      session_id: "s1",
      turn_id: "t1",
      role: "user",
      content: "请记住：wrapper 不可用时 conversation monitor 不能推进 cursor。",
      observed_at: "2026-06-04T00:00:00.000Z",
    })}\n`, "utf8");

    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-conversation-monitor-worker.ts", "--once"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        MEMORY_XX_RUNTIME_DIR: dir,
        MEMORY_XX_CONVERSATION_SPOOL_PATH: path.join(spoolDir, "*.jsonl"),
        MEMORY_XX_CONVERSATION_SOURCE_TAIL: "0",
        MEMORY_XX_WRAPPER_URL: "http://127.0.0.1:9",
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:9/memory_xx",
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /conversation_monitor_worker_failed|conversation_events_posted|fetch failed|ECONNREFUSED/u);
    assert.equal(existsSync(cursorPath), false);
    assert.match(await readFile(spoolPath, "utf8"), /wrapper 不可用/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
