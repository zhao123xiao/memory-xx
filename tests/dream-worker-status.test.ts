import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("dream worker records degraded status when wrapper tasks fail", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-dream-worker-"));
  try {
    const statusFile = path.join(dir, "dream.status.json");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-dream-worker.ts", "--once"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        MEMORY_XX_DREAM_STATUS_FILE: statusFile,
        MEMORY_XX_DREAM_TASK_TIMEOUT_MS: "200",
        MEMORY_XX_WRAPPER_URL: "http://127.0.0.1:9",
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(statusFile), true);
    const status = JSON.parse(await readFile(statusFile, "utf8")) as {
      ok?: boolean;
      phase?: string;
      worker_id?: string;
      report?: { summary?: { failed?: number } };
    };
    assert.equal(status.ok, false);
    assert.equal(status.phase, "processed_with_failures");
    assert.match(status.worker_id ?? "", /^dream-worker-/u);
    assert.equal(typeof status.report?.summary?.failed, "number");
    assert.ok((status.report?.summary?.failed ?? 0) > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
