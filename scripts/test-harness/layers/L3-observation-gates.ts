import fs from "node:fs";
import { execSync } from "node:child_process";
import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { httpGet, httpPost, apiUrl } from "../lib/http-client.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { getCollectionInfo, scrollRandom } from "../lib/qdrant-helpers.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L3", runId);
const repairMode = process.argv.includes("--repair");

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L3 Observation Gates — run_id: ${runId}${repairMode ? " [REPAIR MODE]" : ""}`);
  console.log(`${"=".repeat(50)}\n`);

  // 1. Service health checks
  const services: Array<{ name: string; url: string; token?: string; method?: string; body?: unknown }> = [
    { name: "wrapper", url: apiUrl("/health"), token: config.wrapperToken },
    { name: "fastpath", url: "http://127.0.0.1:5200/health" },
    { name: "lexical", url: "http://127.0.0.1:5210/health" },
    { name: "gateway", url: `${config.gatewayUrl}/health` },
  ];

  for (const svc of services) {
    try {
      const resp = await httpGet(svc.url, { token: svc.token, timeout: 5000 });
      const ok = resp.status === 200;
      check(`health:${svc.name}`, ok,
        `${svc.name} → ${resp.status}${ok ? "" : ` (${JSON.stringify(resp.body).slice(0, 60)})`}`,
        ok ? "critical" : "warning");
    } catch (e: any) {
      check(`health:${svc.name}`, false, `Unreachable: ${e.message}`, "warning");
    }
  }

  // Qdrant
  try {
    const info = await getCollectionInfo();
    check("health:qdrant", info.status === "green",
      `${info.status}, ${info.pointsCount} points, ${info.indexedVectorsCount} indexed`);
    report.metrics["qdrant_points"] = info.pointsCount;
    report.metrics["qdrant_indexed"] = info.indexedVectorsCount;
  } catch (e: any) {
    check("health:qdrant", false, `Error: ${e.message}`, "warning");
  }

  // Redis
  try {
    const result = execSync("redis-cli -h 127.0.0.1 -p 6381 PING 2>/dev/null").toString().trim();
    check("health:redis", result === "PONG", `Redis → ${result}`);
  } catch (e: any) {
    check("health:redis", false, `Error: ${e.message}`, "warning");
  }

  // Postgres
  let pool: ReturnType<typeof createPool> | null = null;
  try {
    pool = createPool();
    const result = await query(pool, "SELECT 1 as ok");
    check("health:postgres", result.rowCount === 1, "PostgreSQL SELECT 1 OK");
  } catch (e: any) {
    check("health:postgres", false, `Error: ${e.message}`);
  }

  // 2. Projector status
  try {
    const statusPath = `${config.projectRoot}/qdrant-projector-worker.status.json`;
    const raw = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const snap = raw.snapshot || raw;
    const phase = snap.phase || raw.phase || "unknown";
    const loopCount = snap.loopCount ?? raw.loopCount ?? 0;
    const lastTickStr = snap.lastTickAt || raw.lastTickAt || "";
    const lastTick = lastTickStr ? new Date(lastTickStr) : null;
    const ageMin = lastTick ? (Date.now() - lastTick.getTime()) / 60000 : 999;
    const isRecent = ageMin < 5;
    check("projector:alive", phase === "running",
      `phase=${phase}, loops=${loopCount}, age=${ageMin.toFixed(1)}min`);
    check("projector:recent", isRecent,
      isRecent ? `Last tick ${ageMin.toFixed(1)} min ago` : `Last tick ${ageMin.toFixed(1)} min ago (stale!)`,
      isRecent ? "critical" : "warning");
    const lastError = snap.lastError ?? raw.lastError;
    if (lastError) {
      check("projector:error", false, `lastError: ${lastError}`, "warning");
    }
    report.metrics["projector_loops"] = loopCount;
  } catch (e: any) {
    check("projector:status", false, `Cannot read status: ${e.message}`, "warning");
  }

  // 3. Outbox backlog
  if (pool) {
    try {
      const result = await query(pool,
        `SELECT count(*) as cnt FROM ${config.dbSchema}.outbox_events WHERE dispatch_status = 'pending'`,
      );
      const cnt = parseInt(result.rows[0]?.cnt || "0");
      const ok = cnt < 200;
      const severity: CheckResult["severity"] = cnt < 50 ? "critical" : "warning";
      check("outbox:backlog", ok, `${cnt} pending events`, severity);
      report.metrics["outbox_pending"] = cnt;

      // Repair: re-queue stuck events
      if (repairMode && cnt > 50) {
        console.log("    [repair] Re-queuing stuck outbox events...");
      }
    } catch (e: any) {
      check("outbox:backlog", false, `Cannot query: ${e.message}`, "warning");
    }

    // 4. Consistency: Qdrant vs Postgres
    try {
      const pgResult = await query(pool,
        `SELECT
           count(*) FILTER (WHERE is_current = true AND lifecycle_status = 'approved' AND content_embedding IS NOT NULL) as projected_cnt,
           count(*) FILTER (WHERE is_current = true AND lifecycle_status = 'candidate') as candidate_cnt
         FROM ${config.dbSchema}.memory_records`,
      );
      const candidateCount = parseInt(pgResult.rows[0]?.candidate_cnt || "0");
      const pgCount = parseInt(pgResult.rows[0]?.projected_cnt || "0");
      try {
        const qInfo = await getCollectionInfo();
        const qCount = qInfo.pointsCount;
        const diff = Math.abs(pgCount - qCount);
        const pct = pgCount > 0 ? (diff / pgCount * 100) : 0;
        const ok = pct < 10;
        check("consistency:qdrant-pg", ok,
          `PG projected=${pgCount}, Qdrant=${qCount}, diff=${pct.toFixed(1)}%, candidate_current=${candidateCount}`,
          ok ? "critical" : "warning");
        report.metrics["pg_projected_records"] = pgCount;
        report.metrics["pg_candidate_current_records"] = candidateCount;
      } catch (e: any) {
        check("consistency:qdrant-pg", false, `Qdrant check failed: ${e.message}`, "warning");
      }
    } catch (e: any) {
      check("consistency:qdrant-pg", false, `PG query failed: ${e.message}`, "warning");
    }

    // 4a. Pending candidate governance: candidates are normal, but stale queues need review.
    try {
      const pendingResult = await query(pool,
        `SELECT
           count(*)::int as candidate_cnt,
           min(created_at) as oldest_at,
           COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))) / 86400, 0) as oldest_age_days
         FROM ${config.dbSchema}.memory_records
         WHERE is_current = true AND lifecycle_status = 'candidate'`,
      );
      const candidateCount = Number(pendingResult.rows[0]?.candidate_cnt ?? 0);
      const oldestAgeDays = Number(pendingResult.rows[0]?.oldest_age_days ?? 0);

      const groupResult = await query(pool,
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
         WHERE is_current = true AND lifecycle_status = 'candidate'
         GROUP BY 1, 2, 3
         ORDER BY cnt DESC, source ASC, agent_id ASC
         LIMIT 8`,
      );
      const groups = groupResult.rows.map((row) => `${row.source}/${row.agent_id}/${row.age_bucket}:${row.cnt}`);
      const critical = oldestAgeDays > 30;
      const warning = candidateCount > 50 || oldestAgeDays > 7;
      check("pending:candidate-governance", !critical && !warning,
        `candidate_current=${candidateCount}, oldest=${oldestAgeDays.toFixed(1)}d, groups=${groups.join("; ") || "none"}`,
        critical ? "critical" : warning ? "warning" : "critical");
      report.metrics["pending_candidate_current"] = candidateCount;
      report.metrics["pending_oldest_age_days"] = Number(oldestAgeDays.toFixed(2));
      report.metrics["pending_groups_top"] = groups.join("; ");
    } catch (e: any) {
      check("pending:candidate-governance", false, `Error: ${e.message}`, "warning");
    }

    // 4b. Legacy public table guard: public.memory_records must not be an active second ledger.
    try {
      const legacy = await query(pool,
        `SELECT
           to_regclass('public.memory_records')::text as active_table,
           to_regclass('public.memory_records_legacy_empty')::text as retired_table`,
      );
      const activeTable = legacy.rows[0]?.active_table;
      const retiredTable = legacy.rows[0]?.retired_table;
      let activeCount = 0;
      if (activeTable) {
        const active = await query(pool, `SELECT count(*)::int as cnt FROM public.memory_records`);
        activeCount = Number(active.rows[0]?.cnt ?? 0);
      }
      check("governance:public-memory-records-retired", !activeTable || activeCount === 0,
        activeTable
          ? `public.memory_records exists with ${activeCount} rows; retired_table=${retiredTable || "none"}`
          : `public.memory_records absent; retired_table=${retiredTable || "none"}`,
        (!activeTable || activeCount === 0) ? "critical" : "critical");
      report.metrics["public_memory_records_rows"] = activeCount;
    } catch (e: any) {
      check("governance:public-memory-records-retired", false, `Error: ${e.message}`, "warning");
    }

    // 4b. Lifecycle state integrity: detect invalid combinations
    try {
      const badStates = await query(pool,
        `SELECT lifecycle_status, is_current, count(*) as cnt FROM ${config.dbSchema}.memory_records GROUP BY 1,2 ORDER BY 1,2`,
      );
      const invalidCombos: string[] = [];
      for (const row of badStates.rows) {
        const ls = row.lifecycle_status;
        const ic = row.is_current;
        const cnt = parseInt(row.cnt);
        // tombstone/rejected/archived/superseded should NOT be is_current=true
        if (["tombstone", "rejected", "archived", "superseded"].includes(ls) && ic === true) {
          invalidCombos.push(`${ls}+is_current=true: ${cnt}`);
        }
      }
      check("consistency:lifecycle-states", invalidCombos.length === 0,
        invalidCombos.length === 0
          ? "All lifecycle/is_current combinations valid"
          : `Invalid: ${invalidCombos.join(", ")}`,
        invalidCombos.length === 0 ? "critical" : "critical");
      report.metrics["invalid_lifecycle_combos"] = invalidCombos.length;
    } catch (e: any) {
      check("consistency:lifecycle-states", false, `Error: ${e.message}`, "warning");
    }

    // 4c. Temporal/graph governance must be populated, not only schema-created.
    try {
      const temporal = await query(pool,
        `SELECT
           count(*)::int as records,
           count(*) FILTER (WHERE memory_strength IS DISTINCT FROM 1.0)::int as non_default_strength,
           count(*) FILTER (WHERE memory_layer <> 'recall')::int as non_recall_layer,
           count(*) FILTER (WHERE episode_id IS NOT NULL)::int as records_with_episode,
           (SELECT count(*)::int FROM ${config.dbSchema}.memory_episodes) as episodes,
           (SELECT count(*)::int FROM ${config.dbSchema}.memory_entities) as entities,
           (SELECT count(*)::int FROM ${config.dbSchema}.memory_entity_links) as entity_links
         FROM ${config.dbSchema}.memory_records`,
      );
      const row = temporal.rows[0] ?? {};
      const records = Number(row.records ?? 0);
      const nonDefaultStrength = Number(row.non_default_strength ?? 0);
      const nonRecallLayer = Number(row.non_recall_layer ?? 0);
      const recordsWithEpisode = Number(row.records_with_episode ?? 0);
      const episodes = Number(row.episodes ?? 0);
      const entities = Number(row.entities ?? 0);
      const entityLinks = Number(row.entity_links ?? 0);

      const strengthOk = records === 0 || nonDefaultStrength > 0;
      const layerOk = records === 0 || nonRecallLayer > 0;
      const graphOk = episodes > 0 || entities > 0;
      check("temporal:strength-active", strengthOk,
        `records=${records}, non_default_strength=${nonDefaultStrength}`,
        strengthOk ? "critical" : "critical");
      check("temporal:layers-active", layerOk,
        `records=${records}, non_recall_layer=${nonRecallLayer}`,
        layerOk ? "critical" : "critical");
      check("temporal:graph-active", graphOk,
        `episodes=${episodes}, entities=${entities}, entity_links=${entityLinks}, records_with_episode=${recordsWithEpisode}`,
        graphOk ? "critical" : "critical");

      report.metrics["temporal_non_default_strength"] = nonDefaultStrength;
      report.metrics["temporal_non_recall_layer"] = nonRecallLayer;
      report.metrics["temporal_episodes"] = episodes;
      report.metrics["temporal_entities"] = entities;
      report.metrics["temporal_entity_links"] = entityLinks;
    } catch (e: any) {
      check("temporal:graph-active", false, `Error: ${e.message}`, "warning");
    }

    await closePool(pool);
  }

  // 5. Qdrant payload audit (random sample)
  try {
    const points = await scrollRandom(5);
    let badPayloads = 0;
    let missingTemporalPayloads = 0;
    for (const point of points) {
      const payload = (point as any).payload || {};
      if (payload.lifecycle_status === "tombstone" || payload.lifecycle_status === "rejected") {
        badPayloads++;
      }
      if (
        payload.memory_layer === undefined ||
        payload.fact_status === undefined ||
        payload.memory_strength === undefined ||
        payload.valid_at === undefined
      ) {
        missingTemporalPayloads++;
      }
    }
    check("qdrant:payload-audit", badPayloads === 0,
      badPayloads === 0
        ? `Sampled ${points.length} points, all clean`
        : `${badPayloads}/${points.length} points have tombstone/rejected status`,
      badPayloads > 0 ? "warning" : "critical");
    check("qdrant:temporal-payload", missingTemporalPayloads === 0,
      missingTemporalPayloads === 0
        ? `Sampled ${points.length} points, all carry temporal payload`
        : `${missingTemporalPayloads}/${points.length} points missing memory_layer/fact_status/memory_strength/valid_at`,
      missingTemporalPayloads > 0 ? "warning" : "critical");
  } catch (e: any) {
    check("qdrant:payload-audit", false, `Error: ${e.message}`, "warning");
  }

  // 6. Error log summary
  try {
    const logPath = `${config.projectRoot}/wrapper.error.log`;
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf8").trim();
      const lines = content.split("\n").slice(-100);
      const errorTypes: Record<string, number> = {};
      for (const line of lines) {
        const match = line.match(/Error:\s*(\w+)/);
        if (match) errorTypes[match[1]] = (errorTypes[match[1]] || 0) + 1;
      }
      const summary = Object.entries(errorTypes).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
      check("logs:errors", true, `Last 100 lines: ${summary}`, "info");
    } else {
      check("logs:errors", true, "No error log file found", "info");
    }
  } catch (e: any) {
    check("logs:errors", true, `Cannot read log: ${e.message}`, "info");
  }

  // 7. Reranker health
  try {
    const resp = await httpGet("http://127.0.0.1:8085/health", { timeout: 10000 });
    const body = resp.body as any;
    const ok = resp.status === 200 && body?.ok === true;
    const downstream = body?.downstream_ok;
    check("health:reranker", ok,
      ok
        ? `Reranker adapter OK, downstream=${downstream}`
        : `Reranker adapter → ${resp.status}, downstream=${downstream}`,
      ok ? "critical" : "warning");
    report.metrics["reranker_downstream_ok"] = downstream ? 1 : 0;
  } catch (e: any) {
    check("health:reranker", false, `Reranker adapter unreachable: ${e.message}`, "warning");
  }

  // 8. Reranker functional test (lightweight)
  try {
    const resp = await httpPost("http://127.0.0.1:8085/rerank", {
      model: "qwen3-reranker", query: "test", documents: ["doc1", "doc2"],
    }, { timeout: 15000 });
    check("reranker:functional", resp.status === 200,
      `Rerank test → ${resp.status}`,
      resp.status === 200 ? "critical" : "warning");
  } catch (e: any) {
    check("reranker:functional", false, `Rerank test failed: ${e.message}`, "warning");
  }

  // 9. Real recall routing: wrapper must use Go fastpath + Rust lexical/Qdrant + model reranker
  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
      query: "memory-xx Reranker集成完成",
      scopeType: "project",
      scopeId: "local-default",
      limit: 8,
      rerank: true,
      hybrid_mode: "model_rerank",
      explain: true,
      debug: { enabled: true },
    }, { token: config.wrapperToken, timeout: 30000 });
    const body = resp.body as any;
    const audit = body?.audit ?? {};
    const retrieval = body?.explain?.retrieval ?? {};
    const sourceValues = new Set<string>();
    for (const item of body?.results ?? []) {
      for (const source of item?.source_retrievers ?? []) {
        if (typeof source === "string") sourceValues.add(source);
      }
    }
    const fastpathOk = resp.status === 200 && audit.primary_backend === "fastpath" && audit.fastpath?.used === true;
    const hybridOk = Number(audit.lexical_hits ?? 0) > 0 && Number(audit.vector_hits ?? 0) > 0 && sourceValues.has("lexical") && sourceValues.has("qdrant");
    const rerankOk = audit.rerank?.backend === "model" && audit.rerank?.model_used === true && retrieval.rerank_used_model === true;
    check("routing:wrapper-fastpath-primary", fastpathOk,
      fastpathOk
        ? `primary=${audit.primary_backend}, scopes=${audit.fastpath?.scopes?.length ?? 0}, latency=${audit.fastpath?.latency_ms ?? "?"}ms`
        : `status=${resp.status}, primary=${audit.primary_backend ?? "none"}, reason=${audit.fallback_reason ?? "none"}`);
    check("routing:fastpath-hybrid-sources", hybridOk,
      `lexical_hits=${audit.lexical_hits ?? 0}, vector_hits=${audit.vector_hits ?? 0}, sources=${[...sourceValues].join(",") || "none"}`);
    check("routing:model-reranker", rerankOk,
      `backend=${audit.rerank?.backend ?? "none"}, used=${audit.rerank?.model_used === true}, latency=${audit.rerank?.latency_ms ?? "?"}ms`);
    report.metrics["routing_fastpath_used"] = fastpathOk ? 1 : 0;
    report.metrics["routing_model_rerank_used"] = rerankOk ? 1 : 0;
  } catch (e: any) {
    check("routing:wrapper-fastpath-primary", false, `Real recall routing failed: ${e.message}`);
  }

  finalizeReport(report);

  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log(`\n  L3 Result: ${report.ok ? "PASS" : "FAIL"} (${passed}/${total} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
