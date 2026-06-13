import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildTemporalOpsSmokeReport } from "../scripts/temporal-ops-smoke";

test("temporal ops smoke reports missing live configuration", async () => {
  const report = await buildTemporalOpsSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_DATABASE_URL"]);
});

test("temporal ops smoke validates dry-run decay and consolidation reportability", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-temporal-ops-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "decay-run.json"), JSON.stringify({
      ok: true,
      mode: "dry-run",
      checked: 27,
      archive_candidate_ids: ["memory_old"],
      applied_ids: [],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "temporal-sweep.json"), JSON.stringify({
      ok: true,
      mode: "dry-run",
      expired_candidate_ids: ["memory_expired"],
      applied_ids: [],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "temporal-policy.json"), JSON.stringify({
      ok: true,
      dry_run: true,
      candidate_count: 2,
      results: [{ memory_id: "memory_tmp", dry_run_action: "human_review_required" }],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "consolidate.json"), JSON.stringify({
      ok: true,
      dry_run: true,
      metrics: {
        layer_rows_touched: 4,
        episodes_created: 1,
        support_relations_created: 2,
      },
      summary: { records: 42 },
    }), "utf8");

    const commands: string[] = [];
    const report = await buildTemporalOpsSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, [
      "temporal_decay",
      "temporal_consolidation",
    ]);
    assert.equal(report.results.temporal_decay?.ok, true);
    assert.equal(report.results.temporal_decay?.degraded, true);
    assert.equal(report.results.temporal_consolidation?.ok, true);
    assert.equal(report.results.temporal_consolidation?.degraded, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => command.includes("--apply")), false);
    assert.equal(commands.some((command) => command.includes(" apply")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
