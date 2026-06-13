import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSelfImprovementOpsSmokeReport } from "../scripts/self-improvement-ops-smoke";

test("self-improvement ops smoke reports missing live configuration", async () => {
  const report = await buildSelfImprovementOpsSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_DATABASE_URL"]);
});

test("self-improvement ops smoke validates report-only self improvement surfaces", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-self-improvement-ops-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "self-improvement.json"), JSON.stringify({
      ok: true,
      proposal_source: "deterministic_fallback",
      proposal: { summary: "report-only proposal" },
      entries: [
        { entry_id: "self-improvement-test", type: "ops_proposal", summary: "test proposal" },
      ],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "graphiti-shadow-export.json"), JSON.stringify({
      ok: true,
      out_path: "/tmp/memory-xx-graphiti-shadow.jsonl",
      records: 1,
    }), "utf8");
    await writeFile(path.join(runtimeDir, "sweep-test-pollution.json"), JSON.stringify({
      ok: true,
      mode: "dry_run",
      matched: 1,
      rejected_count: 0,
      failures: [],
    }), "utf8");

    const commands: string[] = [];
    const report = await buildSelfImprovementOpsSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_WRAPPER_URL: "http://127.0.0.1:5100",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, ["self_improvement_ops"]);
    assert.equal(report.results.self_improvement_ops?.ok, true);
    assert.equal(report.results.self_improvement_ops?.degraded, false);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => command.includes("--dry-run")), true);
    assert.equal(commands.some((command) => command.includes("--deterministic")), true);
    assert.equal(commands.some((command) => command.includes("--no-write-memory")), true);
    assert.equal(commands.some((command) => command.includes("--apply")), false);
    assert.equal(commands.some((command) => command.includes("--write-markdown")), false);
    assert.equal(commands.some((command) => command.includes("memory-governance-cleanup")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
