#!/usr/bin/env tsx
import "./test-harness/config.js";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import {
  buildHumanReviewActionPlan,
  isHumanReviewActionAlreadyApplied,
  isExecutableHumanReviewAction,
  type HumanReviewAction,
  parseHumanReviewMarkdown,
} from "../app/governance/human-review-apply";
import { requireCliPermission } from "../app/server/permissions.js";
import { DEFAULT_AGENT_ID, LifecycleStatus, OutboxEventType, ReviewState, type JsonObject } from "../app/shared";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

interface Args {
  readonly reviewFile: string;
  readonly apply: boolean;
  readonly json: boolean;
}

function argValue(name: string): string {
  const inlinePrefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(inlinePrefix));
  if (inline) return inline.slice(inlinePrefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function showHelp(): void {
  process.stdout.write([
    "Human Review Apply",
    "",
    "Usage:",
    "  npm run memory:human-review-apply -- --review-file <file> --dry-run --json",
    "  npm run memory:human-review-apply -- --review-file <file> --apply --json",
    "",
    "Options:",
    "  --review-file, --file <file>  Markdown review queue file",
    "  --apply                      Apply reviewed changes to Postgres and governance audit",
    "  --json                       Emit JSON output",
    "",
  ].join("\n"));
}

function parseArgs(): Args {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    showHelp();
    process.exit(0);
  }
  const reviewFile = argValue("--review-file") || argValue("--file");
  if (!reviewFile) throw new Error("missing_required_arg:--review-file");
  return {
    reviewFile: resolve(reviewFile),
    apply: process.argv.includes("--apply"),
    json: process.argv.includes("--json"),
  };
}

function splitScope(scope: string | null): { scopeType: string | null; scopeId: string | null } {
  if (!scope) return { scopeType: null, scopeId: null };
  const index = scope.indexOf(":");
  if (index <= 0) return { scopeType: null, scopeId: null };
  return { scopeType: scope.slice(0, index), scopeId: scope.slice(index + 1) };
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

async function insertGovernanceAction(
  client: import("pg").PoolClient,
  schema: string,
  input: {
    readonly runId: string;
    readonly action: HumanReviewAction;
    readonly status: "reported" | "applied" | "skipped" | "failed";
    readonly beforeState: JsonObject;
    readonly afterState: JsonObject;
    readonly evidence?: JsonObject;
  },
): Promise<string> {
  const scope = splitScope(input.action.target_scope ?? input.action.source_scope);
  const actionId = newId("governance_action");
  await client.query(
    `INSERT INTO ${schema}.memory_governance_actions (
       id, run_id, action_type, scope_type, scope_id, memory_id, selector, evidence,
       before_state, after_state, outbox_event_ids, status, created_by, created_at
     )
     VALUES ($1, NULL, 'human_review_apply', $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, '[]'::jsonb, $9, 'memory:human-review-apply', now())`,
    [
      actionId,
      scope.scopeType,
      scope.scopeId,
      input.action.memory_id,
      JSON.stringify({ run_id: input.runId, label: input.action.label, review_file_action: input.action.action }),
      JSON.stringify({
        run_id: input.runId,
        label: input.action.label,
        title: input.action.title,
        action: input.action.action,
        review_decision: input.action.review_decision,
        reason: input.action.reason,
        ...(input.evidence ?? {}),
      }),
      JSON.stringify(input.beforeState),
      JSON.stringify(input.afterState),
      input.status,
    ],
  );
  return actionId;
}

async function findExistingGovernanceAction(
  client: import("pg").PoolClient,
  schema: string,
  action: HumanReviewAction,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM ${schema}.memory_governance_actions
      WHERE action_type = 'human_review_apply'
        AND evidence->>'label' = $1
        AND evidence->>'action' = $2
        AND evidence->>'review_decision' = $3
        AND status IN ('reported', 'applied', 'skipped')
      ORDER BY created_at DESC
      LIMIT 1`,
    [action.label, action.action, action.review_decision],
  );
  return result.rows[0]?.id ?? null;
}

async function appendLifecycleEvent(
  client: import("pg").PoolClient,
  schema: string,
  row: { readonly id: string; readonly request_id: string },
  payload: JsonObject,
): Promise<string> {
  const memoryEventId = newId("memory_event");
  const outboxEventId = newId("outbox_event");
  await client.query(
    `INSERT INTO ${schema}.memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
     VALUES ($1, $2, $3, $4, 'memory:human-review-apply', $5::jsonb, now())`,
    [memoryEventId, row.id, row.request_id, OutboxEventType.MemoryLifecycleChanged, JSON.stringify(payload)],
  );
  await client.query(
    `INSERT INTO ${schema}.outbox_events (
       id, aggregate_id, request_id, event_type, payload, payload_version, dispatch_status, attempts, created_at, dispatched_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'pending', 0, now(), NULL)`,
    [outboxEventId, row.id, row.request_id, OutboxEventType.MemoryLifecycleChanged, JSON.stringify(payload)],
  );
  return outboxEventId;
}

async function ensureGlobalConstraintMemory(
  client: import("pg").PoolClient,
  schema: string,
  runId: string,
  sourceAction: HumanReviewAction,
): Promise<{ readonly memoryId: string; readonly created: boolean }> {
  const existing = await client.query<{ id: string }>(
    `SELECT id
       FROM ${schema}.memory_records
      WHERE scope_type = 'global'
        AND scope_id = 'global'
        AND is_current = true
        AND lifecycle_status = 'approved'
        AND metadata->>'human_review_promoted_from' = $1
      LIMIT 1`,
    [sourceAction.memory_id],
  );
  if (existing.rows[0]?.id) return { memoryId: existing.rows[0].id, created: false };

  const requestId = `human_review_global_${randomUUID()}`;
  await client.query(
    `INSERT INTO ${schema}.ingest_requests (
       request_id, command_type, payload_hash, payload_json, actor_id, status, first_seen_at, last_seen_at, completed_at
     )
     VALUES ($1, 'memory.create', $2, $3::jsonb, 'memory:human-review-apply', 'completed', now(), now(), now())
     ON CONFLICT (request_id) DO NOTHING`,
    [
      requestId,
      `human-review-global:${sourceAction.memory_id ?? sourceAction.label}`,
      JSON.stringify({
        source: "human_review_apply",
        source_memory_id: sourceAction.memory_id,
        label: sourceAction.label,
      }),
    ],
  );
  const memoryId = newId("memory_record");
  await client.query(
    `INSERT INTO ${schema}.memory_records (
       id, request_id, scope_type, scope_id, content, title, summary, metadata, dedupe_key,
       lifecycle_status, review_state, is_current, version, created_by, updated_by, created_at, updated_at,
       tenant_id, agent_id, governance_status, visibility, memory_type, memory_layer, fact_status, valid_at, observed_at
     )
     VALUES (
       $1, $2, 'global', 'global', $3, $4, $5, $6::jsonb, $7,
       'approved', 'silent_approved', true, 1, 'memory:human-review-apply', 'memory:human-review-apply', now(), now(),
       'default', $8, 'normal', 'scope_only', 'constraint', 'core', 'current', now(), now()
     )`,
    [
      memoryId,
      requestId,
      "最终返回结果使用中文。",
      "Output must be in Chinese",
      "用户人工审核确认：最终返回结果应使用中文。",
      JSON.stringify({
        source: "human_review_apply",
        recall_policy: "default",
        memory_class: "constraint",
        cognitive_type: "semantic",
        human_review_promoted_from: sourceAction.memory_id,
        human_review_apply: {
          run_id: runId,
          label: sourceAction.label,
          action: sourceAction.action,
          review_decision: sourceAction.review_decision,
        },
      }),
      "global:global:constraint:output-language:zh",
      DEFAULT_AGENT_ID,
    ],
  );
  await appendLifecycleEvent(client, schema, { id: memoryId, request_id: requestId }, {
    action: "human_review_global_constraint_created",
    memory_id: memoryId,
    source_memory_id: sourceAction.memory_id,
  });
  return { memoryId, created: true };
}

async function applyMemoryAction(
  client: import("pg").PoolClient,
  schema: string,
  runId: string,
  action: HumanReviewAction,
): Promise<Record<string, unknown>> {
  if (!isExecutableHumanReviewAction(action)) {
    const existingActionId = await findExistingGovernanceAction(client, schema, action);
    if (existingActionId) {
      return { status: "skipped", action_id: existingActionId, action: action.action, label: action.label, reason: "already_recorded" };
    }
    const actionId = await insertGovernanceAction(client, schema, {
      runId,
      action,
      status: "skipped",
      beforeState: {},
      afterState: { observation: "kept_pending" },
    });
    return { status: "skipped", action_id: actionId, action: action.action, label: action.label, reason: action.reason };
  }
  if (action.action === "collect_more_samples") {
    const existingActionId = await findExistingGovernanceAction(client, schema, action);
    if (existingActionId) {
      return { status: "reported", action_id: existingActionId, action: action.action, label: action.label, reason: "already_recorded" };
    }
    const actionId = await insertGovernanceAction(client, schema, {
      runId,
      action,
      status: "reported",
      beforeState: {},
      afterState: { observation: "collect_more_samples" },
    });
    return { status: "reported", action_id: actionId, action: action.action, label: action.label };
  }
  if (!action.memory_id) return { status: "skipped", action: action.action, label: action.label, reason: "missing_memory_id" };

  const currentResult = await client.query(
    `SELECT id, request_id, scope_type, scope_id, lifecycle_status, review_state, is_current, metadata, fact_status
       FROM ${schema}.memory_records
      WHERE id = $1
      FOR UPDATE`,
    [action.memory_id],
  );
  const row = currentResult.rows[0] as undefined | {
    id: string;
    request_id: string;
    scope_type: string;
    scope_id: string;
    lifecycle_status: string;
    review_state: string;
    is_current: boolean;
    metadata: JsonObject;
    fact_status: string | null;
  };
  if (!row) return { status: "skipped", action: action.action, label: action.label, memory_id: action.memory_id, reason: "memory_not_found" };
  if (isHumanReviewActionAlreadyApplied(action, row.metadata)) {
    const existingActionId = await findExistingGovernanceAction(client, schema, action);
    return {
      status: "skipped",
      action_id: existingActionId,
      action: action.action,
      label: action.label,
      memory_id: action.memory_id,
      reason: "already_applied",
    };
  }

  const beforeState: JsonObject = {
    lifecycle_status: row.lifecycle_status,
    review_state: row.review_state,
    is_current: row.is_current,
    metadata: row.metadata ?? {},
    fact_status: row.fact_status,
  };
  const appliedAt = new Date().toISOString();
  const metadataPatch = {
    human_review_apply: {
      run_id: runId,
      label: action.label,
      action: action.action,
      review_decision: action.review_decision,
      applied_at: appliedAt,
    },
    human_review_reason: action.reason,
    ...(action.action === "approve_project_memory" ? { recall_policy: "explicit_only", memory_class: "constraint" } : {}),
    ...(action.action === "global_constraint" ? { recall_policy: "default", memory_class: "constraint", promoted_to_scope: "global:global" } : {}),
    ...(action.action === "knowledge_index" ? { recall_policy: "never", memory_class: "audit_evidence", knowledge_index_requested: true } : {}),
    ...(action.action === "event_log_only" ? { recall_policy: "never", memory_class: "runtime_noise" } : {}),
    ...(action.action === "temporal_isolate" ? {
      recall_policy: action.target_recall_policy ?? "explicit_only",
      memory_class: "operational_issue",
      review_at: appliedAt,
      temporal_review_status: "human_reviewed_isolated",
    } : {}),
  };

  let afterState: JsonObject;
  if (action.action === "global_constraint") {
    const global = await ensureGlobalConstraintMemory(client, schema, runId, action);
    await client.query(
      `UPDATE ${schema}.memory_records
          SET lifecycle_status = 'rejected',
              review_state = 'rejected',
              is_current = false,
              metadata = metadata || $2::jsonb,
              invalid_at = COALESCE(invalid_at, now()),
              updated_by = 'memory:human-review-apply',
              updated_at = now()
        WHERE id = $1`,
      [action.memory_id, JSON.stringify({ ...metadataPatch, promoted_memory_id: global.memoryId })],
    );
    afterState = {
      lifecycle_status: LifecycleStatus.Rejected,
      review_state: ReviewState.Rejected,
      is_current: false,
      promoted_memory_id: global.memoryId,
      promoted_created: global.created,
      metadata_patch: { ...metadataPatch, promoted_memory_id: global.memoryId },
    };
  } else if (action.action === "approve_project_memory") {
    await client.query(
      `UPDATE ${schema}.memory_records
          SET lifecycle_status = 'approved',
              review_state = 'silent_approved',
              is_current = true,
              metadata = metadata || $2::jsonb,
              updated_by = 'memory:human-review-apply',
              updated_at = now()
        WHERE id = $1`,
      [action.memory_id, JSON.stringify(metadataPatch)],
    );
    afterState = { lifecycle_status: LifecycleStatus.Approved, review_state: ReviewState.SilentApproved, is_current: true, metadata_patch: metadataPatch };
  } else if (action.action === "temporal_isolate") {
    await client.query(
      `UPDATE ${schema}.memory_records
          SET metadata = metadata || $2::jsonb,
              fact_status = $3,
              updated_by = 'memory:human-review-apply',
              updated_at = now()
        WHERE id = $1`,
      [action.memory_id, JSON.stringify(metadataPatch), action.target_fact_status ?? "historical"],
    );
    afterState = { metadata_patch: metadataPatch, fact_status: action.target_fact_status ?? "historical" };
  } else {
    await client.query(
      `UPDATE ${schema}.memory_records
          SET lifecycle_status = 'rejected',
              review_state = 'rejected',
              is_current = false,
              metadata = metadata || $2::jsonb,
              invalid_at = COALESCE(invalid_at, now()),
              updated_by = 'memory:human-review-apply',
              updated_at = now()
        WHERE id = $1`,
      [action.memory_id, JSON.stringify(metadataPatch)],
    );
    afterState = { lifecycle_status: LifecycleStatus.Rejected, review_state: ReviewState.Rejected, is_current: false, metadata_patch: metadataPatch };
  }
  const outboxEventId = await appendLifecycleEvent(client, schema, row, {
    action: "human_review_apply",
    memory_id: action.memory_id,
    review_action: action.action,
    before: beforeState,
    after: afterState,
  });
  const actionId = await insertGovernanceAction(client, schema, {
    runId,
    action,
    status: "applied",
    beforeState,
    afterState: { ...afterState, outbox_event_id: outboxEventId },
  });
  return { status: "applied", action_id: actionId, outbox_event_id: outboxEventId, action: action.action, label: action.label, memory_id: action.memory_id };
}

async function applyPlan(actions: readonly HumanReviewAction[]): Promise<Record<string, unknown>> {
  await requireCliPermission("memory:governance_apply");
  const pgConfig = loadMemoryXXPostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  const schema = quoteIdent(pgConfig.schema);
  const runId = `human-review-apply-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  const applied: Record<string, unknown>[] = [];
  try {
    await client.query("BEGIN");
    for (const action of actions) applied.push(await applyMemoryAction(client, schema, runId, action));
    await client.query("COMMIT");
    return { run_id: runId, applied };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const markdown = readFileSync(args.reviewFile, "utf8");
  const parsed = parseHumanReviewMarkdown(markdown);
  const plan = buildHumanReviewActionPlan(parsed, { reviewFile: args.reviewFile });
  const applied = args.apply
    ? await applyPlan(plan.actions)
    : {
        skipped: plan.actions.map((action) => ({
          label: action.label,
          memory_id: action.memory_id,
          action: action.action,
          reason: "dry_run",
        })),
      };
  const result = {
    ok: true,
    mode: args.apply ? "apply" : "dry_run",
    apply_allowed: args.apply,
    plan,
    applied,
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`memory human-review ${result.mode}: ${JSON.stringify(plan.summary)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
