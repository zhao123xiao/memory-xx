#!/usr/bin/env tsx
import "./test-harness/config.js";

import { readFile } from "node:fs/promises";

import { executeGraphRelationRetargetPlan } from "../app/governance";
import type { GraphRelationRetargetApplyPlan } from "../app/governance/graph-relation-repair-plan";
import { PostgresWriteDatabase, loadMemoryXXPostgresConfig } from "../app/db";
import { requireCliPermission } from "../app/server/permissions.js";
import { loadDotenvIfPresent } from "./lib/runtime-env";

loadDotenvIfPresent();

export interface GraphRelationRepairApplyCliArgs {
  readonly planFile: string;
  readonly apply: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly actorId: string;
  readonly runId: string;
  readonly help: boolean;
}

export function normalizeGraphRelationRepairApplyCliArgs(argv: readonly string[] = process.argv): GraphRelationRepairApplyCliArgs {
  const help = argv.includes("--help") || argv.includes("-h");
  const planFile = readArg(argv, "plan-file");
  if (!help && !planFile) throw new Error("--plan-file is required");

  const apply = argv.includes("--apply");
  const dryRun = help || argv.includes("--dry-run") || !apply;
  const actorId = readArg(argv, "actor-id") || "memory-graph-relation-repair-apply";
  const runId = readArg(argv, "run-id") || `graph-relation-repair-apply-${new Date().toISOString().replace(/[:.]/gu, "-")}`;

  return {
    planFile,
    apply,
    dryRun,
    json: true,
    actorId,
    runId,
    help,
  };
}

export function parseGraphRelationRetargetPlanJson(content: string): GraphRelationRetargetApplyPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`plan file must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const plan = readObject(parsed).apply_plan ?? parsed;
  const object = readObject(plan);
  assertStringField(object, "kind");
  if (object.kind !== "graph_relation_retarget") {
    throw new Error("plan.kind must be graph_relation_retarget");
  }
  assertStringField(object, "relation_id");
  assertStringField(object, "source_memory_id");
  assertStringField(object, "old_related_memory_id");
  assertStringField(object, "new_related_memory_id");

  return {
    kind: "graph_relation_retarget",
    relation_id: object.relation_id,
    source_memory_id: object.source_memory_id,
    old_related_memory_id: object.old_related_memory_id,
    new_related_memory_id: object.new_related_memory_id,
  };
}

async function main(): Promise<void> {
  const args = normalizeGraphRelationRepairApplyCliArgs(process.argv);
  if (args.help) {
    writeJson({
      ok: true,
      usage: "memory:graph-relation-repair-apply -- --plan-file=<plan.json> [--dry-run|--apply] [--actor-id=<id>] [--run-id=<id>]",
      required: ["--plan-file"],
      modes: ["--dry-run", "--apply"],
    });
    return;
  }
  await requireCliPermission(args.apply ? "memory:governance_apply" : "memory:governance_read");

  const plan = parseGraphRelationRetargetPlanJson(await readFile(args.planFile, "utf8"));
  if (args.dryRun) {
    writeJson({
      ok: true,
      mode: "dry-run",
      run_id: args.runId,
      actor_id: args.actorId,
      plan,
      would_apply: false,
    });
    return;
  }

  const database = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  const result = await executeGraphRelationRetargetPlan(database, {
    plan,
    actorId: args.actorId,
    runId: args.runId,
  });
  writeJson({
    ok: result.ok,
    mode: "apply",
    run_id: args.runId,
    actor_id: args.actorId,
    result,
  });
}

function readArg(argv: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertStringField(object: Record<string, unknown>, field: string): asserts object is Record<typeof field, string> {
  if (typeof object[field] !== "string" || object[field].trim() === "") {
    throw new Error(`plan.${String(field)} must be a non-empty string`);
  }
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
