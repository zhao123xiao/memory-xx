#!/usr/bin/env tsx
import "./test-harness/config.js";

import { readFile } from "node:fs/promises";

import { PostgresWriteDatabase, loadMemoryXXPostgresConfig } from "../app/db";
import {
  executeAdaptiveRetrievalThresholdPlan,
  type AdaptiveRetrievalApplyPlan,
} from "../app/governance";
import { requireCliPermission } from "../app/server/permissions.js";
import { loadDotenvIfPresent } from "./lib/runtime-env";

loadDotenvIfPresent();

export interface AdaptiveRetrievalApplyCliArgs {
  readonly planFile: string;
  readonly apply: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly actorId: string;
  readonly runId: string;
  readonly defaultThreshold: number;
  readonly ttlDays: number;
}

export function normalizeAdaptiveRetrievalApplyCliArgs(argv: readonly string[] = process.argv): AdaptiveRetrievalApplyCliArgs {
  const planFile = readArg(argv, "plan-file");
  if (!planFile) throw new Error("--plan-file is required");
  const apply = argv.includes("--apply");
  const defaultThreshold = readNumberArg(argv, "default-threshold", 0.2, 0.01, 0.99);
  const ttlDays = readIntegerArg(argv, "ttl-days", 14, 1, 90);
  return {
    planFile,
    apply,
    dryRun: argv.includes("--dry-run") || !apply,
    json: true,
    actorId: readArg(argv, "actor-id") || "memory-adaptive-retrieval-apply",
    runId: readArg(argv, "run-id") || `adaptive-retrieval-apply-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    defaultThreshold,
    ttlDays,
  };
}

export function parseAdaptiveRetrievalApplyPlanJson(content: string): AdaptiveRetrievalApplyPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`plan file must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plan = readObject(parsed).apply_plan ?? parsed;
  const object = readObject(plan);
  assertStringField(object, "kind");
  if (object.kind !== "adaptive_retrieval_threshold_delta") {
    throw new Error("plan.kind must be adaptive_retrieval_threshold_delta");
  }
  assertStringField(object, "scope_key");
  if (object.scope_key.startsWith("memory:")) {
    throw new Error("plan.scope_key must not target explicit memory lookup");
  }
  assertStringField(object, "query_type");
  assertStringField(object, "delta");
  if (object.delta !== "loosen" && object.delta !== "tighten") {
    throw new Error("plan.delta must be loosen or tighten");
  }
  const maxDelta = typeof object.max_delta === "number" && Number.isFinite(object.max_delta)
    ? object.max_delta
    : Number.NaN;
  if (!Number.isFinite(maxDelta) || maxDelta <= 0) {
    throw new Error("plan.max_delta must be a positive number");
  }
  return {
    kind: "adaptive_retrieval_threshold_delta",
    scope_key: object.scope_key,
    query_type: object.query_type,
    delta: object.delta,
    max_delta: maxDelta,
  };
}

async function main(): Promise<void> {
  const args = normalizeAdaptiveRetrievalApplyCliArgs(process.argv);
  await requireCliPermission(args.apply ? "memory:governance_apply" : "memory:governance_read");

  const plan = parseAdaptiveRetrievalApplyPlanJson(await readFile(args.planFile, "utf8"));
  if (args.dryRun) {
    writeJson({
      ok: true,
      mode: "dry-run",
      run_id: args.runId,
      actor_id: args.actorId,
      default_threshold: args.defaultThreshold,
      ttl_days: args.ttlDays,
      plan,
      would_apply: false,
    });
    return;
  }

  const database = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  const result = await executeAdaptiveRetrievalThresholdPlan(database, {
    plan,
    actorId: args.actorId,
    runId: args.runId,
    defaultThreshold: args.defaultThreshold,
    ttlDays: args.ttlDays,
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

function readNumberArg(argv: readonly string[], name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(readArg(argv, name) || String(fallback));
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function readIntegerArg(argv: readonly string[], name: string, fallback: number, min: number, max: number): number {
  return Math.floor(readNumberArg(argv, name, fallback, min, max));
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertStringField(object: Record<string, unknown>, field: string): asserts object is Record<typeof field, string> {
  if (typeof object[field] !== "string" || object[field].trim() === "") {
    throw new Error(`plan.${field} must be a non-empty string`);
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
