#!/usr/bin/env tsx
import "./test-harness/config.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  evaluateP1ProductionGate,
  evaluateP1ProductionGateWithDatabase
} from "../app/p1-production-gate";
import { loadMemoryV2PostgresConfig, PostgresWriteDatabase } from "../app/db";

function loadDefaultMetricsEnv(): void {
  if (process.env.MEMORY_V2_P1_GATE_METRICS_JSON?.trim()) return;
  const explicit = process.env.MEMORY_V2_P1_GATE_METRICS_FILE?.trim();
  const fallback = join(process.cwd(), "reports", "memory-xx-cutover", "m4-local-agent-gate-metrics.json");
  const file = explicit || fallback;
  if (!existsSync(file)) return;
  process.env.MEMORY_V2_P1_GATE_METRICS_JSON = readFileSync(file, "utf8");
}

function loadDefaultPolicyTrainingEnv(): void {
  if (process.env.MEMORY_V2_POLICY_TRAINING_SUMMARY_JSON?.trim()) return;
  const explicit = process.env.MEMORY_V2_POLICY_TRAINING_SUMMARY_FILE?.trim();
  if (explicit && existsSync(explicit)) {
    process.env.MEMORY_V2_POLICY_TRAINING_SUMMARY_JSON = readFileSync(explicit, "utf8");
    return;
  }
  const root = join(process.cwd(), "reports", "policy-training");
  if (!existsSync(root)) return;
  const candidates = readdirSync(root)
    .map((entry) => join(root, entry, "summary.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0]?.path;
  if (latest) process.env.MEMORY_V2_POLICY_TRAINING_SUMMARY_JSON = readFileSync(latest, "utf8");
}

async function main(): Promise<void> {
  loadDefaultMetricsEnv();
  loadDefaultPolicyTrainingEnv();
  if (!process.env.MEMORY_V2_DATABASE_URL?.trim()) {
    const result = evaluateP1ProductionGate(process.env);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const database = new PostgresWriteDatabase({
    config: loadMemoryV2PostgresConfig(process.env)
  });
  try {
    const result = await evaluateP1ProductionGateWithDatabase(process.env, { database });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    status: "fail",
    blockers: [`p1_gate_execution_failed:${message}`],
    warnings: []
  }, null, 2));
  process.exitCode = 1;
});
