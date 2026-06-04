import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGovernanceOpsSmokeReport } from "../scripts/governance-ops-smoke";

test("governance ops smoke reports missing live configuration", async () => {
  const report = await buildGovernanceOpsSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_DATABASE_URL"]);
});

test("governance ops smoke validates read-only governance report surfaces", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-governance-ops-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "pending.json"), JSON.stringify({
      ok: true,
      candidate_current: 2,
      pending: [{ id: "candidate-1", suggested_action: "normal_review" }],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "pending-governance.json"), JSON.stringify({
      ok: true,
      mode: "dry_run",
      matched: 1,
      eligible: 1,
      candidates: [{ id: "candidate-1", action: "would_reject" }],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "pending-canary-report.json"), JSON.stringify({
      run_id: "pending-canary-test",
      pending_count: 2,
      sweep_summary: { would_keep_pending: 1 },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "policy-backfill.json"), JSON.stringify({
      ok: true,
      mode: "dry_run",
      before_pending_candidate_count: 2,
      plan: { summary: { total: 2 } },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "event-lifecycle.json"), JSON.stringify({
      ok: true,
      mode: "scan",
      apply: false,
      events: [{ event_type: "memory.created", count: 2 }],
    }), "utf8");

    const commands: string[] = [];
    const report = await buildGovernanceOpsSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, ["governance_operations"]);
    assert.equal(report.results.governance_operations?.ok, true);
    assert.equal(report.results.governance_operations?.degraded, false);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => command.includes("--apply")), false);
    assert.equal(commands.some((command) => command.includes("--write-report")), false);
    assert.equal(commands.some((command) => command.includes("memory-governance-cleanup.ts")), false);
    assert.equal(commands.some((command) => command.includes("memory-governance-freeze.ts")), false);
    assert.equal(commands.some((command) => command.includes("memory-governance-revert.ts")), false);
    assert.equal(commands.some((command) => command.includes("memory-governance-stuck-runs.ts")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
