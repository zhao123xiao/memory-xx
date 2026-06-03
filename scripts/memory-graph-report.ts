import fs from "node:fs";
import path from "node:path";
import { config } from "./test-harness/config.js";
import { createPool, query, closePool } from "./test-harness/lib/db-helpers.js";

async function main(): Promise<void> {
  const pool = createPool();
  const outDir = path.join(config.projectRoot, "reports", "memory-graph", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const overview = await query(pool, `
      SELECT
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_records) AS records,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_episodes) AS episodes,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_entities) AS entities,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_entity_links) AS entity_links,
        (SELECT count(*)::int FROM ${config.dbSchema}.memory_relations) AS relations
    `);

    const episodeSamples = await query(pool, `
      SELECT e.id, e.title, e.occurred_at, e.ended_at, e.metadata,
             count(mr.id)::int AS memory_count
      FROM ${config.dbSchema}.memory_episodes e
      LEFT JOIN ${config.dbSchema}.memory_records mr ON mr.episode_id = e.id
      GROUP BY e.id
      ORDER BY memory_count DESC, e.occurred_at DESC NULLS LAST
      LIMIT 50
    `);

    const relationSamples = await query(pool, `
      SELECT relation_type, count(*)::int AS cnt
      FROM ${config.dbSchema}.memory_relations
      GROUP BY relation_type
      ORDER BY cnt DESC
    `);

    const duplicateSamples = await query(pool, `
      WITH active AS (
        SELECT id, scope_type, scope_id, COALESCE(memory_type, 'unknown') AS memory_type,
               left(regexp_replace(lower(trim(content)), '\\s+', ' ', 'g'), 180) AS content_preview,
               regexp_replace(lower(trim(content)), '\\s+', ' ', 'g') AS normalized_content
        FROM ${config.dbSchema}.memory_records
        WHERE is_current IS TRUE AND lifecycle_status = 'approved' AND review_state IN ('approved', 'not_required')
      )
      SELECT scope_type, scope_id, memory_type, content_preview, count(*)::int AS cnt,
             array_agg(id ORDER BY id) AS memory_ids
      FROM active
      GROUP BY 1,2,3,4, normalized_content
      HAVING count(*) > 1
      ORDER BY cnt DESC
      LIMIT 50
    `);

    const lowStrength = await query(pool, `
      SELECT id, scope_type, scope_id, memory_type, title, memory_strength, updated_at
      FROM ${config.dbSchema}.memory_records
      WHERE is_current IS TRUE AND lifecycle_status = 'approved'
      ORDER BY memory_strength ASC, updated_at ASC
      LIMIT 50
    `);

    const report = {
      ok: true,
      generated_at: new Date().toISOString(),
      schema: config.dbSchema,
      overview: overview.rows[0],
      episodes: episodeSamples.rows,
      relation_counts: relationSamples.rows,
      duplicate_clusters: duplicateSamples.rows,
      low_strength_candidates: lowStrength.rows,
    };

    fs.writeFileSync(path.join(outDir, "graph-report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, "graph-report.html"), renderHtml(report));
    console.log(JSON.stringify({ ok: true, out_dir: outDir, files: ["graph-report.json", "graph-report.html"] }, null, 2));
  } finally {
    await closePool(pool);
  }
}

function renderHtml(report: Record<string, any>): string {
  const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char] ?? char));
  const rows = (items: readonly Record<string, unknown>[]) => items.map((item) =>
    `<tr>${Object.values(item).map((value) => `<td>${esc(Array.isArray(value) ? value.join(", ") : JSON.stringify(value) ?? value)}</td>`).join("")}</tr>`
  ).join("\n");
  const table = (title: string, items: readonly Record<string, unknown>[]) => {
    if (items.length === 0) return `<h2>${esc(title)}</h2><p>none</p>`;
    const headers = Object.keys(items[0] ?? {});
    return `<h2>${esc(title)}</h2><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows(items)}</tbody></table>`;
  };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>memory-xx graph report</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;line-height:1.4}table{border-collapse:collapse;width:100%;margin:12px 0 28px}td,th{border:1px solid #ddd;padding:6px;vertical-align:top;font-size:12px}th{background:#f5f5f5;text-align:left}code{background:#f6f8fa;padding:2px 4px}</style>
</head><body>
<h1>memory-xx graph report</h1>
<p>Generated at <code>${esc(report.generated_at)}</code>, schema <code>${esc(report.schema)}</code>.</p>
${table("Overview", [report.overview])}
${table("Episodes", report.episodes)}
${table("Relation Counts", report.relation_counts)}
${table("Duplicate Clusters", report.duplicate_clusters)}
${table("Low Strength Candidates", report.low_strength_candidates)}
</body></html>`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
