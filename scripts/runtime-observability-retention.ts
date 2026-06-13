#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { requireCliPermission } from "../app/server/permissions";
import {
  buildRuntimeObservabilityRetentionPlan,
  pruneRuntimeObservabilityRetention,
} from "./control-panel/runtime-observability-store.js";
import { argValue, hasArg, loadDotenvIfPresent, printJson } from "./lib/runtime-env";

loadDotenvIfPresent();

function intArg(name: string): number | undefined {
  const raw = argValue(name);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const apply = hasArg("--apply");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");

  const config = loadMemoryXXPostgresConfig();
  const plan = buildRuntimeObservabilityRetentionPlan({
    componentSnapshotDays: intArg("--component-days"),
    agentConnectionDays: intArg("--agent-days"),
    opsAdvisorDays: intArg("--ops-days"),
    codeGraphSnapshotDays: intArg("--code-graph-days"),
    codeGraphKeepLatestPerProject: intArg("--code-graph-keep-latest"),
  });
  const result = await pruneRuntimeObservabilityRetention({
    schema: config.schema,
    apply,
    plan,
  });

  const reportDir = join(process.cwd(), "reports", "runtime-observability-retention");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  const payload = {
    ...result,
    report_path: reportPath,
  };
  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  printJson(payload);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
