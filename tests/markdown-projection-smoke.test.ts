import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryWriteDatabase } from "../app/db";
import { buildMarkdownProjectionSmokeReport, insertProjectionSmokeMemory } from "../scripts/markdown-projection-smoke";

test("markdown projection smoke reports missing live configuration", async () => {
  const report = await buildMarkdownProjectionSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_DATABASE_URL"]);
});

test("markdown projection smoke validates worker status and generated markdown", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-markdown-projection-smoke-test-"));
  const projectionRoot = await mkdtemp(path.join(os.tmpdir(), "memory-xx-markdown-projection-root-test-"));
  try {
    await writeFile(path.join(runtimeDir, "markdown-projection.status.json"), JSON.stringify({
      worker: "markdown_projection",
      success: true,
      docsWritten: 2,
      docsSkipped: 0,
      docsRemoved: 0,
      at: "2026-06-04T00:00:00.000Z",
    }), "utf8");
    const markdownPath = path.join(projectionRoot, "projects", "memory-xx-smoke.md");
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, "# Memory XX Smoke\n\nProjection marker.\n", "utf8");

    const report = await buildMarkdownProjectionSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
      },
      runtimeDir,
      projectionRoot,
      seedMemory: async () => "memory-xx-markdown-smoke-record",
      runWorker: async () => undefined,
      listGeneratedMarkdown: async () => [markdownPath],
    });

    assert.equal(report.ok, true);
    assert.equal(report.memory_id, "memory-xx-markdown-smoke-record");
    assert.equal(report.worker_status?.success, true);
    assert.equal(report.worker_status?.docsWritten, 2);
    assert.deepEqual(report.generated_markdown_files, [markdownPath]);
    assert.deepEqual(report.blockers, []);
    assert.match(await readFile(markdownPath, "utf8"), /Memory XX Smoke/u);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(projectionRoot, { recursive: true, force: true });
  }
});

test("markdown projection smoke seed registers ingest request before memory record", async () => {
  const db = new InMemoryWriteDatabase();
  const memoryId = await insertProjectionSmokeMemory(db);
  const snapshot = await db.snapshot();
  const record = snapshot.memoryRecords.find((row) => row.id === memoryId);

  assert.ok(record);
  assert.equal(snapshot.ingestRequests.length, 1);
  assert.equal(snapshot.ingestRequests[0].requestId, record.requestId);
  assert.equal(snapshot.ingestRequests[0].commandType, "memory.create");
  assert.equal(record.lifecycleStatus, "approved");
  assert.equal(record.reviewState, "approved");
});
