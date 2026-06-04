import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPolicyOpsSmokeReport } from "../scripts/policy-ops-smoke";

test("policy ops smoke reports missing live configuration", async () => {
  const report = await buildPolicyOpsSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_DATABASE_URL"]);
});

test("policy ops smoke validates policy, auto approval, and auto update reportability", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-policy-ops-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "policy-eval.json"), JSON.stringify({
      ok: true,
      results: [
        { name: "runtime_continue", passed: true },
        { name: "unknown_source", passed: true },
      ],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "policy-report.json"), JSON.stringify({
      ok: true,
      windows: { last_24h: { total: 3, policy_coverage_rate: 1 } },
      compare_observations: { status: "below_minimum" },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "auto-approval-ops.json"), JSON.stringify({
      ok: true,
      mode: "report_only",
      recommendations: [{ action: "observe", severity: "info" }],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "auto-update-dry-run.json"), JSON.stringify({
      ok: true,
      dry_run: true,
      scope: "project:memory-xx",
      candidate_count: 0,
      action_counts: {},
    }), "utf8");

    const report = await buildPolicyOpsSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
      },
      runtimeDir,
      runCommand: async (_name, _args, outputFile) => outputFile,
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, [
      "policy_evaluation",
      "auto_approval_ops",
      "auto_update_ops",
    ]);
    assert.equal(report.results.policy_evaluation?.ok, true);
    assert.equal(report.results.policy_evaluation?.degraded, true);
    assert.equal(report.results.auto_approval_ops?.ok, true);
    assert.equal(report.results.auto_update_ops?.ok, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
