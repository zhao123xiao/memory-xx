import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
