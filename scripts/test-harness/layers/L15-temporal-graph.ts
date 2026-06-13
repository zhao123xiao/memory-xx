import { config } from "../config.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { httpPost, apiUrl } from "../lib/http-client.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L15", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L15 Temporal Graph — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  const pool = createPool();
  try {
    const temporal = await query(pool, `
      SELECT
        count(*)::int AS records,
        count(*) FILTER (WHERE memory_strength IS DISTINCT FROM 1.0)::int AS non_default_strength,
        count(*) FILTER (WHERE memory_layer <> 'recall')::int AS non_recall_layer,
        count(*) FILTER (WHERE valid_at IS NOT NULL AND observed_at IS NOT NULL)::int AS time_covered,
        count(*) FILTER (WHERE usage_count > 0 OR last_accessed_at IS NOT NULL)::int AS access_reinforced,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_episodes) AS episodes,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_entities) AS entities,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_entity_links) AS entity_links,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_relations) AS relations
      FROM ${config.dbSchema}.memory_records
    `);
    const row = temporal.rows[0] ?? {};
    const records = Number(row.records ?? 0);
    const nonDefaultStrength = Number(row.non_default_strength ?? 0);
    const nonRecallLayer = Number(row.non_recall_layer ?? 0);
    const timeCovered = Number(row.time_covered ?? 0);
    const accessReinforced = Number(row.access_reinforced ?? 0);
    const episodes = Number(row.episodes ?? 0);
    const entities = Number(row.entities ?? 0);
    const links = Number(row.entity_links ?? 0);
    const relations = Number(row.relations ?? 0);

    check("temporal:strength-layer-time", nonDefaultStrength > 0 && nonRecallLayer > 0 && timeCovered > 0,
      `records=${records}, non_default_strength=${nonDefaultStrength}, non_recall_layer=${nonRecallLayer}, time_covered=${timeCovered}`);
    check("temporal:access-reinforcement", accessReinforced > 0,
      `access_reinforced=${accessReinforced}`,
      accessReinforced > 0 ? "critical" : "warning");
    check("graph:coverage", episodes > 0 && entities > 0 && links > 0 && relations > 0,
      `episodes=${episodes}, entities=${entities}, entity_links=${links}, relations=${relations}`);

    report.metrics["temporal_non_default_strength"] = nonDefaultStrength;
    report.metrics["temporal_non_recall_layer"] = nonRecallLayer;
    report.metrics["temporal_time_covered"] = timeCovered;
    report.metrics["temporal_access_reinforced"] = accessReinforced;
    report.metrics["graph_episodes"] = episodes;
    report.metrics["graph_entities"] = entities;
    report.metrics["graph_entity_links"] = links;
    report.metrics["graph_relations"] = relations;
  } finally {
    await closePool(pool);
  }

  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
      query: "memory-xx",
      explain: true,
      limit: 3,
      temporal_scope: "current"
    }, { token: config.wrapperToken, timeout: 15000 });
    const body = resp.body as any;
    const temporal = body?.audit?.temporal ?? body?.explain?.temporal;
    check("recall:audit-temporal", resp.status === 200 && temporal?.applied_temporal_scope === "current",
      `status=${resp.status}, temporal_scope=${temporal?.applied_temporal_scope ?? "missing"}`);
  } catch (error) {
    check("recall:audit-temporal", false, error instanceof Error ? error.message : String(error), "warning");
  }

  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  check("fatal", false, error instanceof Error ? error.message : String(error));
  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(1);
});
