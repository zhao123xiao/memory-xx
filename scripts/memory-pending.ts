import { config } from "./test-harness/config.js";
import { createPool, query, closePool } from "./test-harness/lib/db-helpers.js";
import { evaluateMemoryPolicy } from "../app/governance/memory-policy-engine";

function parseLimit(): number {
  const arg = process.argv.find((item) => item.startsWith("--limit="));
  const value = arg ? Number(arg.split("=")[1]) : 50;
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 200) : 50;
}

function parseFilter(name: string): string | null {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  const value = arg ? arg.slice(name.length + 3).trim() : "";
  return value || null;
}

function ageBucket(days: number): string {
  if (days < 1) return "lt_1d";
  if (days < 7) return "1_7d";
  if (days < 30) return "7_30d";
  return "gt_30d";
}

function suggestedAction(days: number, memoryClass: string, recallPolicy: string, policyAction: string): string {
  if (policyAction === "reject_by_policy" || memoryClass === "explicit_no_memory" || memoryClass === "runtime_noise") return "reject_by_policy_safe";
  if (memoryClass === "operational_issue") return "review_operational_issue";
  if (memoryClass === "unknown_source_quarantine" || policyAction === "quarantine_candidate") return "confirm_or_reject_quarantine";
  if (memoryClass === "test_evidence" || recallPolicy === "test_only") return "review_test_only_scope";
  if (memoryClass === "audit_evidence" || recallPolicy === "audit_only") return "review_audit_only_scope";
  if (days > 30) return "review_or_reject_required";
  if (days > 7) return "review_soon";
  return "normal_review";
}

function inferPolicy(row: any): { memory_class: string; recall_policy: string; policy_action: string } {
  const existingClass = typeof row.memory_class === "string" && row.memory_class !== "unclassified" ? row.memory_class : "";
  const existingRecall = typeof row.recall_policy === "string" ? row.recall_policy : "";
  const existingAction = typeof row.policy_action === "string" ? row.policy_action : "";
  if (existingClass) {
    return {
      memory_class: existingClass,
      recall_policy: existingRecall || "default",
      policy_action: existingAction || "create_candidate",
    };
  }
  const result = evaluateMemoryPolicy({
    source: typeof row.source === "string" ? row.source : "unknown",
    sourceText: typeof row.content_preview === "string" ? row.content_preview : "",
    baseDecision: "pending",
    blockedReasons: [],
    candidate: {
      scopeType: typeof row.scope_type === "string" ? row.scope_type : "project",
      scopeId: typeof row.scope_id === "string" ? row.scope_id : "unknown",
      memoryType: typeof row.memory_type === "string" && row.memory_type !== "unknown" ? row.memory_type : null,
      operation: "create",
      confidence: 0.7,
      qualityScore: 0.7,
      title: typeof row.title === "string" ? row.title : null,
      content: typeof row.content_preview === "string" ? row.content_preview : "",
      metadata: {
        source: typeof row.source === "string" ? row.source : "unknown",
      },
    },
  });
  return {
    memory_class: result.memory_class,
    recall_policy: result.recall_policy,
    policy_action: result.policy_action,
  };
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const classFilter = parseFilter("class");
  const recallPolicyFilter = parseFilter("recall-policy");
  const policyActionFilter = parseFilter("policy-action");
  const sourceFilter = parseFilter("source");
  const pool = createPool();
  try {
    const filters: string[] = [];
    const params: unknown[] = [];
    function addFilter(sql: string, value: string | null): void {
      if (!value) return;
      params.push(value);
      filters.push(sql.replace("$?", `$${params.length}`));
    }
    addFilter("COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') = $?", classFilter);
    addFilter("COALESCE(metadata->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy') = $?", recallPolicyFilter);
    addFilter("COALESCE(metadata->>'policy_action', metadata->'auto_approval_policy'->'memory_policy'->>'policy_action') = $?", policyActionFilter);
    addFilter("COALESCE(metadata->>'source', 'unknown') = $?", sourceFilter);
    const filterSql = filters.length ? ` AND ${filters.join(" AND ")}` : "";

    const summary = await query(pool,
      `SELECT
         count(*)::int as candidate_cnt,
         min(created_at) as oldest_at,
         COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))) / 86400, 0) as oldest_age_days
       FROM ${config.dbSchema}.memory_records
       WHERE is_current = true AND lifecycle_status = 'candidate'${filterSql}`,
      params,
    );

    const candidateCount = Number(summary.rows[0]?.candidate_cnt ?? 0);
    const oldestAgeDays = Number(summary.rows[0]?.oldest_age_days ?? 0);

    const groups = await query(pool,
      `SELECT
         COALESCE(metadata->>'source', 'unknown') as source,
         COALESCE(metadata->>'agent_id', created_by, 'unknown') as agent_id,
         CASE
           WHEN created_at >= now() - interval '1 day' THEN 'lt_1d'
           WHEN created_at >= now() - interval '7 days' THEN '1_7d'
           WHEN created_at >= now() - interval '30 days' THEN '7_30d'
           ELSE 'gt_30d'
         END as age_bucket,
         count(*)::int as cnt
       FROM ${config.dbSchema}.memory_records
       WHERE is_current = true AND lifecycle_status = 'candidate'${filterSql}
       GROUP BY 1, 2, 3
       ORDER BY cnt DESC, source ASC, agent_id ASC`,
      params,
    );

    const rowParams = [...params, limit];
    const rows = await query(pool,
      `SELECT
         id,
         scope_type,
         scope_id,
         title,
         left(content, 160) as content_preview,
         COALESCE(metadata->>'source', 'unknown') as source,
         COALESCE(metadata->>'memory_type', 'unknown') as memory_type,
         COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class', 'unclassified') as memory_class,
         COALESCE(metadata->>'recall_policy', metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', 'default') as recall_policy,
         COALESCE(metadata->>'policy_action', metadata->'auto_approval_policy'->'memory_policy'->>'policy_action', 'create_candidate') as policy_action,
         COALESCE(metadata->>'agent_id', created_by, 'unknown') as agent_id,
         created_at,
         EXTRACT(EPOCH FROM (now() - created_at)) / 86400 as age_days
       FROM ${config.dbSchema}.memory_records
       WHERE is_current = true AND lifecycle_status = 'candidate'${filterSql}
       ORDER BY CASE
          WHEN COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') = 'operational_issue' THEN 0
          WHEN COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') = 'unknown_source_quarantine' THEN 1
          WHEN COALESCE(metadata->>'memory_class', metadata->'auto_approval_policy'->'memory_policy'->>'memory_class') IN ('test_evidence', 'audit_evidence') THEN 2
          ELSE 3
        END,
        created_at ASC
       LIMIT $${rowParams.length}`,
      rowParams,
    );

    const detailRows = rows.rows.map((row) => {
      const days = Number(row.age_days ?? 0);
      const policy = inferPolicy(row);
      return {
        id: row.id,
        scope: `${row.scope_type}:${row.scope_id}`,
        source: row.source,
        agent_id: row.agent_id,
        memory_type: row.memory_type,
        memory_class: policy.memory_class,
        recall_policy: policy.recall_policy,
        policy_action: policy.policy_action,
        age_days: Number(days.toFixed(2)),
        age_bucket: ageBucket(days),
        suggested_action: suggestedAction(days, policy.memory_class, policy.recall_policy, policy.policy_action),
        title: row.title,
        content_preview: row.content_preview,
      };
    }).sort((left, right) => {
      const rank = (item: { memory_class: string }) =>
        item.memory_class === "operational_issue" ? 0 :
        item.memory_class === "unknown_source_quarantine" ? 1 :
        item.memory_class === "test_evidence" || item.memory_class === "audit_evidence" ? 2 :
        3;
      const priority = rank(left) - rank(right);
      return priority !== 0 ? priority : right.age_days - left.age_days;
    });

    const result = {
      ok: oldestAgeDays <= 30,
      schema: config.dbSchema,
      filters: {
        memory_class: classFilter,
        recall_policy: recallPolicyFilter,
        policy_action: policyActionFilter,
        source: sourceFilter,
      },
      candidate_current: candidateCount,
      oldest_age_days: Number(oldestAgeDays.toFixed(2)),
      governance: {
        warning: candidateCount > 50 || oldestAgeDays > 7,
        critical: oldestAgeDays > 30,
        policy: "candidate records are not projected to Qdrant and are not included in default recall; review/reject/archive instead of physical delete",
      },
      groups: groups.rows,
      pending: detailRows,
    };

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.governance.critical ? 1 : 0);
  } finally {
    await closePool(pool);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
