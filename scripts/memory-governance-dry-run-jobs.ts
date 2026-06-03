import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";
import { evaluateAutoApprovalPolicy } from "../app/governance/auto-approval-policy";
import { stableGovernanceSelectorHash } from "../app/governance/service";
import { requireCliPermission } from "../app/server/permissions";
import type { JsonObject } from "../app/shared";
import { argValue, loadDotenvIfPresent, printJson, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

const JOBS = ["self_improvement_report", "silent_approve_dry_run", "consolidation_dry_run"] as const;

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function loadCandidateOnlyFlag(): Promise<{ enabled: boolean; reasons: string[] }> {
  if (process.env.MEMORY_V2_INTELLIGENCE_CANDIDATE_ONLY === "true") {
    return { enabled: true, reasons: ["env_candidate_only"] };
  }
  const runtimeDir = process.env.MEMORY_V2_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
  try {
    const parsed = JSON.parse(await readFile(join(runtimeDir, "intelligence-candidate-only.json"), "utf8")) as { enabled?: unknown; reasons?: unknown };
    return {
      enabled: parsed.enabled === true,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { enabled: false, reasons: [] };
  }
}

async function hasScopeGrant(client: import("pg").PoolClient, schema: string, agentId: string, scopeType: string, scopeId: string): Promise<boolean> {
  const rows = await client.query(
    `
      SELECT true AS ok
      FROM ${schema}.trusted_agent_scope_grants
      WHERE agent_id = $1
        AND scope_type = $2
        AND (scope_id = $3 OR scope_id = '*')
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND ('memory:write' = ANY(permissions) OR 'memory:admin' = ANY(permissions))
      LIMIT 1
    `,
    [agentId, scopeType, scopeId]
  );
  return Boolean(rows.rows[0]?.ok);
}

async function recentSilentApprovedCount(client: import("pg").PoolClient, schema: string, input: { agentId: string; scopeType: string; scopeId: string; source: string }): Promise<number> {
  const rows = await client.query<{ count: string }>(
    `
      SELECT count(*) AS count
      FROM ${schema}.memory_records
      WHERE lifecycle_status = 'approved'
        AND review_state = 'silent_approved'
        AND scope_type = $1
        AND scope_id = $2
        AND COALESCE(agent_id, metadata->>'agent_id', created_by) = $3
        AND COALESCE(metadata->>'source', '') = $4
        AND created_at >= now() - interval '1 hour'
    `,
    [input.scopeType, input.scopeId, input.agentId, input.source]
  );
  return Number(rows.rows[0]?.count ?? 0);
}

async function loadSilentApproveEnabled(client: import("pg").PoolClient, schema: string, input: {
  readonly agentId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType: string;
  readonly source: string;
}): Promise<boolean> {
  const selector = {
    agent_id: input.agentId,
    scope_type: input.scopeType,
    scope_id: input.scopeId,
    memory_type: input.memoryType || "unknown",
    source: input.source,
  } satisfies JsonObject;
  const rows = await client.query<{ auto_approve_enabled: boolean | null }>(
    `
      SELECT auto_approve_enabled
      FROM ${schema}.governance_policy_overrides
      WHERE selector_hash = $1
        AND policy_type = 'silent_approve'
        AND expires_at > now()
      LIMIT 1
    `,
    [stableGovernanceSelectorHash(selector)]
  );
  return rows.rows[0]?.auto_approve_enabled === false ? false : true;
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_read");
  const requested = argValue("--job");
  const jobs = requested ? JOBS.filter((job) => job === requested) : [...JOBS];
  if (jobs.length === 0) throw new Error(`unknown job: ${requested}`);
  const config = loadMemoryV2PostgresConfig();
  const schema = quoteIdent(config.schema);
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  const reportDir = join(process.cwd(), "reports", "governance-dry-run");
  await mkdir(reportDir, { recursive: true });
  const reports: Array<Record<string, unknown>> = [];
  try {
    for (const job of jobs) {
      let metrics: Record<string, unknown>;
      if (job === "self_improvement_report") {
        const result = await client.query(
          `
            SELECT
              (SELECT count(*)::int FROM ${schema}.memory_governance_runs WHERE status = 'running') AS running_runs,
              (SELECT count(*)::int FROM ${schema}.memory_records WHERE lifecycle_status = 'candidate' AND review_state = 'pending') AS pending_candidates,
              (SELECT count(*)::int FROM ${schema}.recall_traces WHERE created_at >= now() - interval '24 hours') AS recall_traces_24h
          `
        );
        metrics = { source: "deterministic_report", ...result.rows[0] };
      } else if (job === "silent_approve_dry_run") {
        const candidateOnly = await loadCandidateOnlyFlag();
        const result = await client.query(
          `
            SELECT id, scope_type, scope_id, memory_type, title, content, metadata,
              COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown') AS agent_id,
              COALESCE(metadata->>'source', '') AS source,
              COALESCE(metadata->>'conflict_action', 'create') AS conflict_action,
              COALESCE((metadata->'quality_gate'->>'score')::float, (metadata->>'quality_score')::float, 0) AS quality_score,
              COALESCE((metadata->>'confidence')::float, 0) AS confidence
            FROM ${schema}.memory_records
            WHERE lifecycle_status = 'candidate'
              AND review_state = 'pending'
              AND scope_id IS NOT NULL
            ORDER BY quality_score DESC NULLS LAST, updated_at DESC
            LIMIT 50
          `
        );
        const candidates = [];
        for (const row of result.rows) {
          const metadata = readObject(row.metadata);
          const source = readString(row.source, "memory-xx-intelligence-smart-write");
          const memoryType = readString(row.memory_type ?? metadata.memory_type);
          const hasGrant = await hasScopeGrant(client, schema, String(row.agent_id), String(row.scope_type), String(row.scope_id)).catch(() => false);
          const autoApproveEnabled = await loadSilentApproveEnabled(client, schema, {
            agentId: String(row.agent_id),
            scopeType: String(row.scope_type),
            scopeId: String(row.scope_id),
            memoryType,
            source,
          }).catch(() => true);
          const decision = evaluateAutoApprovalPolicy({
            mode: "write",
            agentId: String(row.agent_id),
            source: source === "memory-xx-intelligence-smart-write" || source === "memory-xx-mcp-smart-write" ? "smart_write" : source,
            sourceText: String(row.content ?? ""),
            candidate: {
              scopeType: String(row.scope_type),
              scopeId: String(row.scope_id),
              memoryType,
              operation: "add",
              conflictAction: readString(row.conflict_action, "create"),
              confidence: Number(row.confidence ?? 0),
              qualityScore: Number(row.quality_score ?? 0),
              title: row.title,
              content: String(row.content ?? ""),
              metadata: metadata as JsonObject,
            },
            trustedAgent: hasGrant,
            hasScopeGrant: hasGrant,
            candidateOnly: candidateOnly.enabled,
            candidateOnlyReasons: candidateOnly.reasons,
            semanticConflict: ["merge", "supersede", "update"].includes(readString(row.conflict_action)),
            semanticDuplicate: false,
            autoApproveEnabled,
            recentApprovedCount: await recentSilentApprovedCount(client, schema, {
              agentId: String(row.agent_id),
              scopeType: String(row.scope_type),
              scopeId: String(row.scope_id),
              source,
            }).catch(() => 0),
          });
          candidates.push({
            id: row.id,
            scope_type: row.scope_type,
            scope_id: row.scope_id,
            memory_type: row.memory_type,
            title: row.title,
            quality_score: row.quality_score,
            confidence: row.confidence,
            source,
            agent_id: row.agent_id,
            auto_approval: decision,
          });
        }
        metrics = {
          policy: "auto_approval_policy_engine",
          policy_mode: "shadow_dry_run",
          candidate_count: candidates.length,
          would_approve_count: candidates.filter((row) => row.auto_approval.decision === "approve").length,
          blocked_count: candidates.filter((row) => row.auto_approval.decision !== "approve").length,
          candidates
        };
      } else {
        const result = await client.query(
          `
            WITH normalized AS (
              SELECT id, scope_type, scope_id, COALESCE(memory_type, 'unknown') AS memory_type,
                regexp_replace(lower(trim(content)), '\\s+', ' ', 'g') AS normalized_content
              FROM ${schema}.memory_records
              WHERE lifecycle_status = 'approved'
                AND is_current IS TRUE
            )
            SELECT scope_type, scope_id, memory_type, normalized_content, count(*)::int AS count,
              array_agg(id ORDER BY id) AS memory_ids
            FROM normalized
            GROUP BY scope_type, scope_id, memory_type, normalized_content
            HAVING count(*) > 1
            ORDER BY count(*) DESC
            LIMIT 50
          `
        );
        metrics = {
          policy: "exact_normalized_content_duplicates_only",
          duplicate_group_count: result.rows.length,
          duplicate_groups: result.rows
        };
      }
      const reportPath = join(reportDir, `${job}-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
      const report = { job_type: job, mode: "dry-run", status: "success", metrics, report_path: reportPath };
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await client.query(
        `
          INSERT INTO ${schema}.memory_governance_runs (
            id, job_type, mode, policy, status, lock_key, started_at, finished_at,
            metrics, error, lease_acquired_by, lease_expires_at, heartbeat_at,
            created_at, updated_at
          )
          VALUES ($1, $2, 'dry-run', $3, 'success', $4, now(), now(),
            $5::jsonb, NULL, NULL, NULL, NULL, now(), now())
        `,
        [
          randomUUID(),
          job,
          job,
          `memory_xx_governance:${job}`,
          JSON.stringify({ ...metrics, report_path: reportPath })
        ]
      );
      reports.push(report);
    }
    printJson({ ok: true, reports });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
