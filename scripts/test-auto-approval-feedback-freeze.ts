#!/usr/bin/env tsx
import "./test-harness/config.js";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { PostgresWriteDatabase } from "../app/db/adapters/postgres-write-database";
import { MemoryFeedbackRepository, type MemoryFeedbackType } from "../app/db/repositories/memory-feedback-repository";
import { applyAutoApprovalFeedbackGovernance } from "../app/governance/auto-approval-feedback";
import { evaluateAutoApprovalPolicy } from "../app/governance/auto-approval-policy";
import { stableGovernanceSelectorHash } from "../app/governance/service";
import type { JsonObject } from "../app/shared";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

async function main(): Promise<void> {
  const runId = `aaf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const scopeId = `memory-xx-auto-approval-freeze-${runId}`;
  const agentId = "codex";
  const memoryType = "fact";
  const source = "conversation_ingest";
  const configPg = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(configPg.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(configPg));
  const writeDatabase = new PostgresWriteDatabase({ config: configPg, pool });
  const client = await pool.connect();
  const createdMemoryIds: string[] = [];
  const createdScopeIds: string[] = [];
  const createdRecallTraceIds: string[] = [];
  try {
    const sampleSize = Math.max(60, Number.parseInt(process.env.MEMORY_XX_AUTO_APPROVAL_MIN_COHORT_SAMPLE ?? "60", 10) || 60);
    const negativeFeedbackCount = Math.max(3, Math.ceil(sampleSize * 0.05));

    const createCohort = async (caseType: string): Promise<{ scopeId: string; selector: JsonObject; memoryIds: string[] }> => {
      const caseScopeId = `${scopeId}-${caseType}`;
      createdScopeIds.push(caseScopeId);
      const memoryIds: string[] = [];
      for (let index = 0; index < sampleSize; index += 1) {
        const requestId = `${runId}-${caseType}-req-${index}`;
        const memoryId = `${runId}-${caseType}-mem-${index}`;
        createdMemoryIds.push(memoryId);
        memoryIds.push(memoryId);
        await client.query(
          `
            INSERT INTO ${schema}.ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, completed_at, result_json)
            VALUES ($1, 'memory.create', $2, $3::jsonb, $4, 'completed', now(), '{}'::jsonb)
            ON CONFLICT (request_id) DO NOTHING
          `,
          [requestId, `${runId}-${caseType}-${index}`, JSON.stringify({ run_id: runId, case_type: caseType, index }), agentId]
        );
        await client.query(
          `
            INSERT INTO ${schema}.memory_records (
              id, request_id, scope_type, scope_id, content, title, metadata, dedupe_key,
              lifecycle_status, review_state, is_current, version, created_by, updated_by,
              agent_id, memory_type, memory_strength, created_at, updated_at
            )
            VALUES ($1, $2, 'project', $3, $4, $5, $6::jsonb, $7,
              'approved', 'silent_approved', true, 1, $8, $8,
              $8, $9, 1.0, now(), now())
            ON CONFLICT (id) DO NOTHING
          `,
          [
            memoryId,
            requestId,
            caseScopeId,
            `memory-xx feedback freeze ${caseType} cohort ${runId} item ${index}`,
            `feedback freeze ${caseType} ${index}`,
            JSON.stringify({ source, auto_approval_random_run_id: runId, auto_approval_test_case_type: `feedback_freeze_${caseType}` }),
            `${runId}:${caseType}:${index}`,
            agentId,
            memoryType,
          ]
        );
        await client.query(
          `
            INSERT INTO ${schema}.auto_approval_decisions (
              id, candidate_memory_id, decision, policy_version, score, reasons, blocked_reasons,
              agent_id, scope_type, scope_id, approved_memory_id, metadata, created_at
            )
            VALUES ($1, NULL, 'approve', 'test-auto-approval-freeze', 0.97, '[]'::jsonb, '[]'::jsonb,
              $2, 'project', $3, $4, $5::jsonb, now())
            ON CONFLICT (id) DO NOTHING
          `,
          [randomUUID(), agentId, caseScopeId, memoryId, JSON.stringify({ source, memory_type: memoryType, run_id: runId, case_type: caseType })]
        );
      }
      return {
        scopeId: caseScopeId,
        selector: {
          agent_id: agentId,
          scope_type: "project",
          scope_id: caseScopeId,
          memory_type: memoryType,
          source,
        } satisfies JsonObject,
        memoryIds,
      };
    };

    const triggerFeedback = async (
      memoryId: string,
      feedbackType: MemoryFeedbackType,
      requestSuffix: string
    ): Promise<Record<string, unknown>> => {
      return writeDatabase.withTransaction(async (tx) => {
        const feedback = await new MemoryFeedbackRepository().add(tx, {
          memoryId,
          actorId: "auto-approval-feedback-freeze",
          feedbackType,
          reason: `freeze cohort validation ${runId}`,
          metadata: { auto_approval_random_run_id: runId, request_suffix: requestSuffix },
        });
        const governance = await applyAutoApprovalFeedbackGovernance(tx, {
          memoryId,
          feedbackEventId: feedback.id,
          feedbackType,
          actorId: "auto-approval-feedback-freeze",
        });
        return {
          status: 200,
          body: {
            ok: true,
            feedback_event_id: feedback.id,
            feedback_type: feedback.feedbackType,
            autoApprovalGovernance: governance as unknown as JsonObject,
          },
        };
      });
    };

    const readOverride = async (selector: JsonObject) => client.query(
      `
        SELECT id, auto_approve_enabled, metadata
        FROM ${schema}.governance_policy_overrides
        WHERE selector_hash = $1
          AND policy_type = 'silent_approve'
          AND expires_at > now()
        LIMIT 1
      `,
      [stableGovernanceSelectorHash(selector)]
    );

    const assertFrozen = async (caseScopeId: string, selector: JsonObject, expectedTrigger: string) => {
      const override = await readOverride(selector);
      const policy = evaluateAutoApprovalPolicy({
        mode: "write",
        agentId,
        source,
        sourceText: `memory-xx frozen ${expectedTrigger} cohort remains pending after policy override ${runId}`,
        candidate: {
          scopeType: "project",
          scopeId: caseScopeId,
          memoryType,
          operation: "add",
          conflictAction: "create",
          confidence: 0.98,
          qualityScore: 0.97,
          title: `frozen cohort ${expectedTrigger} ${runId}`,
          content: `memory-xx frozen ${expectedTrigger} cohort remains pending after policy override ${runId}`,
          metadata: { source, auto_approval_random_run_id: runId },
        },
        trustedAgent: true,
        hasScopeGrant: true,
        candidateOnly: false,
        candidateOnlyReasons: [],
        semanticConflict: false,
        semanticDuplicate: false,
        autoApproveEnabled: false,
        recentApprovedCount: 0,
      });
      return {
        ok: override.rows[0]?.auto_approve_enabled === false && policy.blocked_reasons.includes("policy_override_disabled"),
        scope_id: caseScopeId,
        expected_trigger: expectedTrigger,
        override: override.rows[0] ?? null,
        subsequent_policy_decision: policy.decision,
        subsequent_blocked_reasons: policy.blocked_reasons,
      };
    };

    const negative = await createCohort("negative");
    const rollback = await createCohort("rollback");
    const manual = await createCohort("manual");
    const recall = await createCohort("recall");

    const feedbackResponses: Array<Record<string, unknown>> = [];
    for (let index = 0; index < negativeFeedbackCount; index += 1) {
      feedbackResponses.push(await triggerFeedback(negative.memoryIds[index], "wrong", `negative-${index}`));
    }

    const metricTriggerCount = Math.max(3, negativeFeedbackCount);
    for (let index = 0; index < metricTriggerCount; index += 1) {
      await client.query(
        `
          INSERT INTO ${schema}.memory_governance_actions (
            id, action_type, scope_type, scope_id, memory_id, selector, evidence,
            before_state, after_state, outbox_event_ids, status, created_by, created_at
          )
          VALUES ($1, 'auto_approval_rollback', 'project', $2, $3, $4::jsonb, $5::jsonb,
            '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'applied', 'test:auto-approval-feedback-freeze', now())
        `,
        [
          randomUUID(),
          rollback.scopeId,
          rollback.memoryIds[index],
          JSON.stringify(rollback.selector),
          JSON.stringify({ source: "test:auto-approval-feedback-freeze", run_id: runId, case_type: "rollback" }),
        ]
      );
    }
    feedbackResponses.push(await triggerFeedback(rollback.memoryIds[0], "confirmed", "rollback-trigger"));

    await client.query(
      `
        UPDATE ${schema}.memory_records
        SET lifecycle_status = 'archived', is_current = false, updated_at = now()
        WHERE id = ANY($1::text[])
      `,
      [manual.memoryIds.slice(0, metricTriggerCount)]
    );
    feedbackResponses.push(await triggerFeedback(manual.memoryIds[0], "confirmed", "manual-trigger"));

    for (let index = 0; index < metricTriggerCount; index += 1) {
      const traceId = `${runId}-recall-trace-${index}`;
      createdRecallTraceIds.push(traceId);
      await client.query(
        `
          INSERT INTO ${schema}.recall_traces (
            id, query_hash, query_excerpt, actor_id, scope_context, query_type, strategy, degrade_level, results, audit, created_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, 'semantic', 'auto-approval-feedback-freeze', 0, '{}'::jsonb, $6::jsonb, now())
        `,
        [
          traceId,
          `${runId}-recall-${index}`,
          `feedback freeze recall negative ${runId} ${index}`,
          "auto-approval-feedback-freeze",
          JSON.stringify({ scope_type: "project", scope_id: recall.scopeId }),
          JSON.stringify({ auto_approval_random_run_id: runId, case_type: "recall" }),
        ]
      );
      await client.query(
        `
          INSERT INTO ${schema}.recall_feedback_events (
            id, recall_trace_id, memory_id, actor_id, feedback_type, suspicious, reason, metadata, created_at
          )
          VALUES ($1, $2, $3, 'auto-approval-feedback-freeze', 'false_positive', false, $4, $5::jsonb, now())
        `,
        [
          randomUUID(),
          traceId,
          recall.memoryIds[index],
          `recall negative freeze validation ${runId}`,
          JSON.stringify({ auto_approval_random_run_id: runId, case_type: "recall" }),
        ]
      );
    }
    feedbackResponses.push(await triggerFeedback(recall.memoryIds[0], "confirmed", "recall-trigger"));

    const cases = [
      await assertFrozen(negative.scopeId, negative.selector, "false_positive_rate"),
      await assertFrozen(rollback.scopeId, rollback.selector, "rollback_rate"),
      await assertFrozen(manual.scopeId, manual.selector, "manual_archive_delete_rate"),
      await assertFrozen(recall.scopeId, recall.selector, "recall_negative_feedback_rate"),
    ];
    const ok = cases.every((item) => item.ok);
    const report = {
      ok,
      run_id: runId,
      scope: `project:${scopeId}-*`,
      sample_size: sampleSize,
      negative_feedback_count: negativeFeedbackCount,
      metric_trigger_count: metricTriggerCount,
      feedback_responses: feedbackResponses,
      cases,
    };
    const reportDir = join(process.cwd(), "reports", "auto-approval-feedback-freeze");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-approval-feedback-freeze-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    await client.query("BEGIN").catch(() => undefined);
    try {
      await client.query(`DELETE FROM ${schema}.recall_feedback_events WHERE memory_id = ANY($1::text[]) OR recall_trace_id = ANY($2::text[])`, [createdMemoryIds, createdRecallTraceIds]);
      await client.query(`DELETE FROM ${schema}.recall_traces WHERE id = ANY($1::text[]) OR audit->>'auto_approval_random_run_id' = $2`, [createdRecallTraceIds, runId]);
      await client.query(`DELETE FROM ${schema}.memory_feedback_events WHERE memory_id = ANY($1::text[])`, [createdMemoryIds]);
      await client.query(`DELETE FROM ${schema}.auto_approval_decisions WHERE scope_id = ANY($1::text[]) OR metadata->>'run_id' = $2`, [createdScopeIds, runId]);
      await client.query(`DELETE FROM ${schema}.memory_governance_actions WHERE scope_id = ANY($1::text[]) OR evidence->>'run_id' = $2`, [createdScopeIds, runId]);
      await client.query(`DELETE FROM ${schema}.governance_policy_overrides WHERE selector->>'scope_id' = ANY($1::text[]) OR metadata->'selector'->>'scope_id' = ANY($1::text[])`, [createdScopeIds]);
      await client.query(`DELETE FROM ${schema}.memory_events WHERE memory_id = ANY($1::text[])`, [createdMemoryIds]);
      await client.query(`DELETE FROM ${schema}.memory_records WHERE id = ANY($1::text[]) OR scope_id = ANY($2::text[])`, [createdMemoryIds, createdScopeIds]);
      await client.query(`DELETE FROM ${schema}.ingest_requests WHERE request_id LIKE $1 OR request_id LIKE $2`, [`${runId}-%-req-%`, `${runId}-feedback-%`]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      process.stderr.write(`feedback freeze cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
