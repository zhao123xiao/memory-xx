import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("write ticket worker writes status file when startup dependencies fail", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-write-ticket-worker-"));
  try {
    const statusFile = path.join(dir, "write-ticket.status.json");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-write-ticket-worker.ts", "--once"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        MEMORY_XX_WRITE_TICKET_WORKER_STATUS_FILE: statusFile,
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:9/memory_xx",
        MEMORY_XX_REDIS_URL: "redis://127.0.0.1:9/0",
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(statusFile), true);
    const status = JSON.parse(await readFile(statusFile, "utf8")) as {
      ok?: boolean;
      phase?: string;
      error?: string;
      worker_id?: string;
    };
    assert.equal(status.ok, false);
    assert.equal(status.phase, "startup_failed");
    assert.equal(typeof status.error, "string");
    assert.match(status.worker_id ?? "", /^write-ticket-worker-/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write ticket worker defaults status file to MEMORY_XX_RUNTIME_DIR", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-write-ticket-runtime-"));
  try {
    const statusFile = path.join(dir, "write-ticket-worker.status.json");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-write-ticket-worker.ts", "--once"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        MEMORY_XX_RUNTIME_DIR: dir,
        MEMORY_XX_WRITE_TICKET_WORKER_STATUS_FILE: "",
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:9/memory_xx",
        MEMORY_XX_REDIS_URL: "redis://127.0.0.1:9/0",
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(statusFile), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
