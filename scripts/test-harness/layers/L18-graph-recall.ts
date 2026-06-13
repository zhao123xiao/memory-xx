import { config } from "../config.js";
import { createClient } from "redis";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { httpPost, apiUrl } from "../lib/http-client.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { mapMemoryIdToQdrantPointId } from "../../../app/qdrant-sync/projector.js";

const runId = generateRunId();
const report = createEmptyReport("L18", runId);

interface GraphRecallCase {
  readonly name: string;
  readonly query: string;
  readonly expected_terms: readonly string[];
  readonly fixture_title: string;
  readonly fixture_content: string;
}

const CASES: readonly GraphRecallCase[] = [
  {
    name: "relation:0020-strict-scope",
    query: "0020 migration 和 strict scope trusted agent grants 有什么关系？",
    expected_terms: ["0020", "strict", "grant"],
    fixture_title: "[L18 GRAPH FIXTURE] 0020 strict scope grant relation",
    fixture_content: "L18 graph recall fixture: 0020 migration depends on strict scope trusted agent grants. path relation: 0020 -> strict scope -> grant.",
  },
  {
    name: "timeline:l3-l4-release",
    query: "memory-xx L3 和 L4 release blocker 修复经历了哪些阶段？",
    expected_terms: ["L3", "L4", "release"],
    fixture_title: "[L18 GRAPH FIXTURE] L3 L4 release timeline",
    fixture_content: "L18 graph recall fixture: memory-xx moved from L3 warning cleanup to L4 release blocker closure, then release-ready doctor gates.",
  },
  {
    name: "decision:qdrant-4096d",
    query: "为什么 memory-xx 4096 维向量要继续使用 Qdrant？",
    expected_terms: ["Qdrant", "4096"],
    fixture_title: "[L18 GRAPH FIXTURE] Qdrant 4096 decision",
    fixture_content: "L18 graph recall fixture: Qdrant remains the ANN index because 4096 dimensional embeddings exceed pgvector index limits and need stable recall.",
  },
  {
    name: "issue:embedding-429",
    query: "embedding 429 对 recall 路径造成了什么影响？",
    expected_terms: ["429", "embedding"],
    fixture_title: "[L18 GRAPH FIXTURE] embedding 429 recall issue",
    fixture_content: "L18 graph recall fixture: embedding 429 caused recall vector degradation, cache fallback, stale query embedding audit, and upstream error tracking.",
  },
  {
    name: "module:doctor-graph",
    query: "memory doctor 和 graph recall 分别对应哪些模块和 gate？",
    expected_terms: ["doctor", "graph"],
    fixture_title: "[L18 GRAPH FIXTURE] doctor graph module gate",
    fixture_content: "L18 graph recall fixture: memory doctor graph-ready checks graph recall evidence, forbidden scope hit rate, benchmark metrics, and release gates.",
  },
];

const FIXTURE_SCOPE_ID = "local-default";
const FIXTURE_IDS = CASES.map((item) => fixtureId(item.name));
let seededFixtures: string[] = [];

function fixtureId(name: string): string {
  return `memory_record_l18_graph_${name.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()}`;
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function ensureEntity(pool: ReturnType<typeof createPool>, name: string): Promise<string> {
  const result = await query(pool, `
    WITH existing AS (
      SELECT id
      FROM ${config.dbSchema}.memory_entities
      WHERE lower(coalesce(canonical_name, name)) = lower($1)
      ORDER BY created_at ASC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO ${config.dbSchema}.memory_entities (entity_type, name, canonical_name, metadata)
      SELECT 'l18_fixture', $1::text, $1::text, jsonb_build_object('source', 'L18-graph-recall', 'run_id', $2::text)
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id
    )
    SELECT id FROM inserted
    UNION ALL
    SELECT id FROM existing
    LIMIT 1
  `, [name, runId]);
  return String(result.rows[0]?.id ?? "");
}

async function seedGraphFixtures(): Promise<string[]> {
  const pool = createPool();
  const seeded: string[] = [];
  try {
    for (const item of CASES) {
      const memoryId = fixtureId(item.name);
      const requestId = `l18-graph-recall:${item.name}:${runId}`;
      const eventPayload = JSON.stringify({
        memoryId,
        requestId,
        source: "L18-graph-recall",
        run_id: runId,
        case: item.name,
      });
      await query(pool, `
        INSERT INTO ${config.dbSchema}.ingest_requests (
          request_id, command_type, payload_hash, payload_json, actor_id,
          status, first_seen_at, last_seen_at, completed_at, result_json
        )
        VALUES (
          $1, 'memory.create', $2, $3::jsonb, 'l18-graph-recall',
          'completed', now(), now(), now(), $4::jsonb
        )
        ON CONFLICT (request_id) DO UPDATE SET
          status = 'completed',
          last_seen_at = now(),
          completed_at = now(),
          result_json = EXCLUDED.result_json,
          error_code = NULL,
          error_message = NULL
      `, [
        requestId,
        `l18:${runId}:${item.name}`,
        JSON.stringify({ source: "L18-graph-recall", run_id: runId, case: item.name }),
        JSON.stringify({ memoryId, requestId, fixture: true })
      ]);
      await query(pool, `
        INSERT INTO ${config.dbSchema}.memory_records (
          id, request_id, tenant_id, agent_id, scope_type, scope_id, memory_type,
          title, content, summary, lifecycle_status, review_state, governance_status,
          visibility, dedupe_key, is_current, confidence, metadata, created_by, updated_by,
          memory_layer, fact_status, importance, memory_strength, valid_at, observed_at
        )
        VALUES (
          $1, $2, 'default', 'l18-graph-recall', 'project', $3, 'fact',
          $4, $5, $6, 'approved', 'not_required', 'normal',
          'scope_only', $7, true, 1.0, $8::jsonb, 'l18-graph-recall', 'l18-graph-recall',
          'recall', 'current', 0.95, 1.0, now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
          request_id = EXCLUDED.request_id,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          summary = EXCLUDED.summary,
          lifecycle_status = 'approved',
          review_state = 'not_required',
          governance_status = 'normal',
          is_current = true,
          confidence = 1.0,
          metadata = EXCLUDED.metadata,
          updated_by = 'l18-graph-recall',
          updated_at = now(),
          archived_at = NULL,
          deleted_at = NULL,
          memory_layer = 'recall',
          fact_status = 'current',
          importance = 0.95,
          memory_strength = 1.0,
          valid_at = now(),
          observed_at = now()
      `, [
        memoryId,
        requestId,
        FIXTURE_SCOPE_ID,
        item.fixture_title,
        item.fixture_content,
        item.fixture_content,
        `l18-graph-recall:${item.name}`,
        JSON.stringify({ source: "L18-graph-recall", run_id: runId, fixture: true, case: item.name })
      ]);
      await query(pool, `
        INSERT INTO ${config.dbSchema}.memory_events (
          id, memory_id, request_id, event_type, actor_id, payload, created_at
        )
        VALUES ($1, $2, $3, 'migration.shadow.loaded', 'l18-graph-recall', $4::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET
          request_id = EXCLUDED.request_id,
          payload = EXCLUDED.payload,
          created_at = now()
      `, [`memory_event:${memoryId}:${runId}`, memoryId, requestId, eventPayload]);
      await query(pool, `
        INSERT INTO ${config.dbSchema}.outbox_events (
          id, aggregate_id, request_id, event_type, payload, payload_version,
          dispatch_status, attempts, created_at, dispatched_at, dispatched_by,
          dispatch_started_at, projection_verified, dispatch_metadata
        )
        VALUES (
          $1, $2, $3, 'migration.shadow.loaded', $4::jsonb, 1,
          'dispatched', 0, now(), now(), 'l18-graph-recall',
          now(), true, jsonb_build_object('source', 'L18-graph-recall', 'run_id', $5::text)
        )
        ON CONFLICT (id) DO UPDATE SET
          request_id = EXCLUDED.request_id,
          payload = EXCLUDED.payload,
          dispatch_status = 'dispatched',
          dispatched_at = now(),
          dispatched_by = 'l18-graph-recall',
          dispatch_started_at = now(),
          projection_verified = true,
          dispatch_metadata = EXCLUDED.dispatch_metadata
      `, [`outbox_event:${memoryId}:${runId}`, memoryId, requestId, eventPayload, runId]);

      await query(pool, `
        INSERT INTO ${config.dbSchema}.memory_sources (id, memory_id, source_type, uri, excerpt, confidence, captured_at, metadata)
        VALUES ($1, $2, 'test-fixture', $3, $4, 1.0, now(), $5::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          excerpt = EXCLUDED.excerpt,
          confidence = 1.0,
          captured_at = now(),
          updated_at = now(),
          metadata = EXCLUDED.metadata
      `, [
        `source:${memoryId}`,
        memoryId,
        `memory-xx://test-harness/L18/${item.name}`,
        item.fixture_content,
        JSON.stringify({ source: "L18-graph-recall", run_id: runId })
      ]);

      for (const term of item.expected_terms) {
        const entityId = await ensureEntity(pool, term);
        if (!entityId) continue;
        await query(pool, `
          INSERT INTO ${config.dbSchema}.memory_entity_links (entity_id, memory_id, role, confidence)
          SELECT $1, $2, 'path_term', 1.0
          WHERE NOT EXISTS (
            SELECT 1 FROM ${config.dbSchema}.memory_entity_links
            WHERE entity_id = $1 AND memory_id = $2
          )
        `, [entityId, memoryId]);
      }

      await query(pool, `
        INSERT INTO ${config.dbSchema}.memory_relations (
          id, memory_id, related_memory_id, relation_type, direction, weight, metadata, relation_metadata
        )
        VALUES ($1, $2, $2, $3, 'bidirectional', 1.0, $4::jsonb, $4::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          relation_type = EXCLUDED.relation_type,
          weight = 1.0,
          metadata = EXCLUDED.metadata,
          relation_metadata = EXCLUDED.relation_metadata,
          updated_at = now()
      `, [
        `relation:${memoryId}:path`,
        memoryId,
        `l18_path_${item.expected_terms.join("_").toLowerCase()}`,
        JSON.stringify({ source: "L18-graph-recall", run_id: runId, case: item.name })
      ]);

      seeded.push(memoryId);
    }
    return seeded;
  } finally {
    await closePool(pool);
  }
}

async function cleanupGraphFixtures(memoryIds: readonly string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  const pool = createPool();
  try {
    const result = await query(pool, `
      UPDATE ${config.dbSchema}.memory_records
      SET lifecycle_status = 'tombstone',
          review_state = 'rejected',
          is_current = false,
          deleted_at = now(),
          updated_at = now(),
          updated_by = 'l18-graph-recall-cleanup'
      WHERE id = ANY($1::text[])
    `, [[...memoryIds]]);
    report.cleanup.performed = true;
    report.cleanup.resources_cleaned.push(...memoryIds);
    check("cleanup:fixtures", result.rowCount === memoryIds.length,
      `tombstoned=${result.rowCount ?? 0}/${memoryIds.length}`,
      result.rowCount === memoryIds.length ? "critical" : "warning");
    const pointIds = memoryIds.map((id) => mapMemoryIdToQdrantPointId(id));
    const qdrantResponse = await fetch(`${config.qdrantUrl}/collections/${config.qdrantCollection}/points/delete?wait=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MEMORY_XX_QDRANT_API_KEY ? { "api-key": process.env.MEMORY_XX_QDRANT_API_KEY } : {}),
      },
      body: JSON.stringify({ points: pointIds }),
      signal: AbortSignal.timeout(10000),
    });
    check("cleanup:qdrant-fixtures", qdrantResponse.ok,
      `deleted_points=${pointIds.length}, status=${qdrantResponse.status}`,
      qdrantResponse.ok ? "critical" : "warning");
    await cleanupRecallCaches();
  } catch (error) {
    report.cleanup.performed = true;
    report.cleanup.failed.push(...memoryIds);
    check("cleanup:fixtures", false, error instanceof Error ? error.message : String(error), "warning");
  } finally {
    await closePool(pool);
  }
}

async function cleanupRecallCaches(): Promise<void> {
  const prefixes = [...new Set([
    process.env.MEMORY_XX_REDIS_PREFIX?.trim(),
    "memory-xx-local-qwen8b-int4",
    "memory-xx",
  ].filter((value): value is string => Boolean(value)))];
  const client = createClient({ url: config.redisUrl });
  let deleted = 0;
  try {
    await client.connect();
    for (const prefix of prefixes) {
      for (const pattern of [
        `${prefix}:cache:search:*`,
        `${prefix}:cache:session:*`,
        `${prefix}:cache:recent:*`,
      ]) {
        for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
          deleted += await client.del(key);
        }
      }
    }
    check("cleanup:recall-cache", true, `deleted_keys=${deleted}`, "warning");
  } catch (error) {
    check("cleanup:recall-cache", false, error instanceof Error ? error.message : String(error), "warning");
  } finally {
    await client.quit().catch(() => undefined);
  }

  for (const scopeId of [FIXTURE_SCOPE_ID]) {
    const response = await fetch("http://127.0.0.1:5200/admin/cache/invalidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopeType: "project", scopeId }),
      signal: AbortSignal.timeout(1000),
    }).catch((error) => ({ ok: false, status: 0, error }) as const);
    const ok = response.ok || response.status === 404;
    check("cleanup:fastpath-cache", ok, `scope=${scopeId}, status=${response.status}${response.status === 404 ? ", cache_absent" : ""}`, "warning");
  }
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L18 Graph Recall — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  seededFixtures = await seedGraphFixtures();
  check("graph:fixtures-seeded", seededFixtures.length === CASES.length, `seeded=${seededFixtures.length}/${CASES.length}`);

  const caseMetrics = [];
  let responseOk = 0;
  let totalTop5 = 0;
  let totalGraphTop5 = 0;
  let totalGraphHits = 0;
  let evidenceCovered = 0;
  let pathCorrect = 0;
  let forbiddenScopeHits = 0;

  for (const item of CASES) {
    const response = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
      query: item.query,
      scopeType: "project",
      scopeId: "local-default",
      query_type_hint: "project_context",
      limit: 8,
      explain: true,
      debug: { enabled: true }
    }, { token: config.wrapperToken, timeout: 30000 });
    const body = response.body as any;
    const results = Array.isArray(body?.results) ? body.results : [];
    const top5 = results.slice(0, 5);
    const graphResults = top5.filter((result: any) =>
      Array.isArray(result?.source_retrievers) && result.source_retrievers.includes("graph")
    );
    const graphHits = Number(body?.audit?.graph_hits ?? 0);
    const forbidden = results.filter((result: any) => result?.scope?.id && result.scope.id !== "local-default").length;
    const expectedMemoryId = fixtureId(item.name);
    const expectedRankIndex = results.findIndex((result: any) =>
      (result?.memory_id || result?.id) === expectedMemoryId
    );
    const expectedRank = expectedRankIndex >= 0 ? expectedRankIndex + 1 : null;
    const expectedResult = expectedRankIndex >= 0 ? results[expectedRankIndex] : null;
    const expectedGraphRank = typeof expectedResult?.graph_rank === "number" ? expectedResult.graph_rank : null;
    const expectedSourceRetrievers = Array.isArray(expectedResult?.source_retrievers)
      ? expectedResult.source_retrievers
      : [];
    const expectedTerms = item.expected_terms.map((term) => term.toLowerCase());
    const expectedHasGraph = expectedSourceRetrievers.includes("graph");
    const correct = expectedRank !== null && expectedRank <= 5 && expectedHasGraph && (() => {
      const haystack = [
        expectedResult?.title,
        expectedResult?.content,
        JSON.stringify(expectedResult?.explain ?? {}),
        JSON.stringify(expectedResult?.graph_entity_evidence ?? {}),
        JSON.stringify(expectedResult?.graph_relation_evidence ?? {}),
        JSON.stringify(expectedResult?.graph_source_evidence ?? {}),
        JSON.stringify(expectedResult?.graph_path_evidence ?? {}),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return expectedTerms.every((term) => haystack.includes(term));
    })();
    const matchedEvidence = expectedResult ? {
      entities: expectedResult.graph_entity_evidence ?? expectedResult.graph_entities ?? [],
      relations: expectedResult.graph_relation_evidence ?? expectedResult.graph_relations ?? [],
      sources: expectedResult.graph_source_evidence ?? expectedResult.graph_evidence_sources ?? [],
      path: expectedResult.graph_path_evidence ?? expectedResult.graph_path ?? [],
      rank_reason: expectedResult.graph_rank_reason ?? null,
    } : null;
    const missReason = correct
      ? "ok"
      : expectedRank === null
        ? "expected_fixture_missing"
        : expectedRank > 5
          ? `expected_fixture_rank_${expectedRank}`
          : !expectedHasGraph
            ? "expected_fixture_not_graph_sourced"
            : "expected_terms_missing";

    if (response.status === 200) responseOk += 1;
    totalTop5 += top5.length;
    totalGraphTop5 += graphResults.length;
    totalGraphHits += graphHits;
    evidenceCovered += expectedRank !== null && expectedRank <= 5 && expectedHasGraph ? 1 : 0;
    pathCorrect += correct ? 1 : 0;
    forbiddenScopeHits += forbidden;
    caseMetrics.push({
      name: item.name,
      status: response.status,
      graph_hits: graphHits,
      graph_top5: graphResults.length,
      top5: top5.length,
      expected_memory_id: expectedMemoryId,
      expected_rank: expectedRank,
      expected_graph_rank: expectedGraphRank,
      path_correct: correct,
      miss_reason: missReason,
      forbidden_scope_hits: forbidden,
      matched_entity_relation_source_path: matchedEvidence,
      sources: graphResults.map((result: any) => result.source_retrievers.join("+")),
      top5_source_mix: top5.map((result: any) => ({
        memory_id: result.memory_id ?? result.id,
        sources: Array.isArray(result.source_retrievers) ? result.source_retrievers.join("+") : "unknown",
        graph_rank: result.graph_rank ?? null,
        title: result.title ?? null,
      })),
    });
  }

  const graphPAt5 = totalTop5 > 0 ? totalGraphTop5 / totalTop5 : 0;
  const evidenceCoverage = CASES.length > 0 ? evidenceCovered / CASES.length : 0;
  const pathCorrectness = CASES.length > 0 ? pathCorrect / CASES.length : 0;
  const forbiddenScopeHitRate = totalTop5 > 0 ? forbiddenScopeHits / totalTop5 : 0;

  check("graph:responses-ok", responseOk === CASES.length, `ok=${responseOk}/${CASES.length}`);
  check("graph:hits", totalGraphHits > 0, `graph_hits=${totalGraphHits}, graph_top5=${totalGraphTop5}`);
  check("graph:p-at-5", graphPAt5 >= 0.60, `p_at_5=${graphPAt5.toFixed(3)}`, "warning");
  check("graph:evidence-source-coverage", evidenceCoverage >= 0.35, `coverage=${evidenceCoverage.toFixed(3)}`);
  check("graph:path-correctness", pathCorrectness >= 0.85, `path_correctness=${pathCorrectness.toFixed(3)}`);
  check("graph:forbidden-scope-hit-rate", forbiddenScopeHits === 0, `forbidden_hits=${forbiddenScopeHits}, rate=${forbiddenScopeHitRate.toFixed(3)}`);
  check("graph:case-metrics", true, JSON.stringify(caseMetrics), "warning");
  await cleanupGraphFixtures(seededFixtures);

  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (error) => {
  check("fatal", false, error instanceof Error ? error.message : String(error));
  await cleanupGraphFixtures(seededFixtures.length > 0 ? seededFixtures : FIXTURE_IDS);
  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(1);
});
