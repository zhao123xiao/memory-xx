import { config } from "./test-harness/config.js";
import { createPool, closePool } from "./test-harness/lib/db-helpers.js";

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

const schema = quoteIdent(config.dbSchema);
const apply = process.argv.includes("--apply");
const dryRun = !apply;

async function main(): Promise<void> {
  if (apply && process.env.MEMORY_V2_ALLOW_LEGACY_DIRECT_LIFECYCLE_SQL !== "true") {
    throw new Error("memory-consolidate apply is blocked: direct lifecycle SQL must be replaced by lifecycle mutation service or explicitly allowed with MEMORY_V2_ALLOW_LEGACY_DIRECT_LIFECYCLE_SQL=true");
  }
  const pool = createPool();
  const client = await pool.connect();
  const startedAt = new Date().toISOString();
  const metrics: Record<string, number> = {};

  try {
    await client.query("BEGIN");

    const layerResult = await client.query(`
      WITH classified AS (
        SELECT
          id,
          CASE
          WHEN lifecycle_status IN ('tombstone', 'rejected') THEN 'audit'
          WHEN lifecycle_status IN ('archived', 'superseded') THEN 'archival'
          WHEN lower(COALESCE(source_kind, '') || ' ' || COALESCE(source_ref, '') || ' ' || COALESCE(metadata->>'source', '')) ~ '(daily|log|episode|conversation|agent|openclaw|local)' THEN 'episodic'
          WHEN memory_type = 'procedure' THEN 'procedural'
          WHEN memory_type IN ('preference', 'constraint') THEN 'core'
          WHEN memory_type IN ('fact', 'decision') THEN 'semantic'
          ELSE 'recall'
          END AS next_memory_layer,
          CASE
          WHEN lifecycle_status = 'superseded' THEN 'deprecated'
          WHEN lifecycle_status IN ('tombstone', 'rejected', 'archived') THEN 'historical'
          WHEN is_current IS TRUE THEN 'current'
          ELSE 'historical'
          END AS next_fact_status,
          COALESCE(valid_at, created_at) AS next_valid_at,
          COALESCE(observed_at, created_at) AS next_observed_at,
          CASE
          WHEN is_current IS NOT TRUE AND invalid_at IS NULL THEN updated_at
          ELSE invalid_at
          END AS next_invalid_at,
          CASE
          WHEN lifecycle_status IN ('tombstone', 'rejected') THEN 0.15
          WHEN lifecycle_status IN ('archived', 'superseded') THEN 0.25
          WHEN memory_type IN ('preference', 'constraint', 'decision') THEN 0.75
          WHEN memory_type = 'procedure' THEN 0.70
          WHEN memory_type = 'fact' THEN 0.60
          WHEN lifecycle_status = 'candidate' THEN 0.45
          ELSE 0.50
          END AS next_importance,
          CASE
          WHEN lifecycle_status IN ('tombstone', 'rejected', 'archived', 'superseded') THEN 'none'
          ELSE 'importance_weighted'
          END AS next_decay_policy
        FROM ${schema}.memory_records
      )
      UPDATE ${schema}.memory_records mr
      SET
        memory_layer = classified.next_memory_layer,
        fact_status = classified.next_fact_status,
        valid_at = classified.next_valid_at,
        observed_at = classified.next_observed_at,
        invalid_at = classified.next_invalid_at,
        importance = classified.next_importance::real,
        decay_policy = classified.next_decay_policy
      FROM classified
      WHERE mr.id = classified.id
        AND (
          mr.memory_layer IS DISTINCT FROM classified.next_memory_layer
          OR mr.fact_status IS DISTINCT FROM classified.next_fact_status
          OR mr.valid_at IS DISTINCT FROM classified.next_valid_at
          OR mr.observed_at IS DISTINCT FROM classified.next_observed_at
          OR mr.invalid_at IS DISTINCT FROM classified.next_invalid_at
          OR mr.importance IS DISTINCT FROM classified.next_importance::real
          OR mr.decay_policy IS DISTINCT FROM classified.next_decay_policy
        )
    `);
    metrics.layer_rows_touched = layerResult.rowCount ?? 0;

    const strengthResult = await client.query(`
      WITH relation_counts AS (
        SELECT id,
          count(*) FILTER (WHERE relation_type IN ('supports', 'refines', 'same_as', 'derived_from'))::float AS support_count,
          count(*) FILTER (WHERE relation_type IN ('conflicts', 'contradicts'))::float AS conflict_count
        FROM (
          SELECT memory_id AS id, relation_type FROM ${schema}.memory_relations
          UNION ALL
          SELECT related_memory_id AS id, relation_type FROM ${schema}.memory_relations
        ) r
        GROUP BY id
      ),
      scored AS (
        SELECT
          mr.id,
          LEAST(1.0, GREATEST(0.0,
            0.50
            + COALESCE(mr.importance, 0.5) * 0.25
            + (LEAST(COALESCE(mr.usage_count, 0), 100)::float / 100.0) * 0.15
            + (LEAST(COALESCE(rc.support_count, 0), 10)::float / 10.0) * 0.10
            + (CASE
                WHEN mr.source_kind IN ('manual', 'user', 'reviewed') THEN 0.08
                WHEN mr.created_by IS NOT NULL AND mr.created_by <> '' THEN 0.05
                ELSE 0.03
              END)
            - (1 - exp(-0.05 * GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(mr.last_accessed_at, mr.updated_at, mr.created_at))) / 86400.0))) * 0.15
            - COALESCE(rc.conflict_count, 0) * 0.10
            - LEAST(1.0, GREATEST(0, (EXTRACT(EPOCH FROM (now() - mr.created_at)) / 86400.0 - 30.0) / 365.0)) * 0.15
          ))::real AS strength
        FROM ${schema}.memory_records mr
        LEFT JOIN relation_counts rc ON rc.id = mr.id
      )
      UPDATE ${schema}.memory_records mr
      SET memory_strength = scored.strength
      FROM scored
      WHERE scored.id = mr.id
        AND (mr.memory_strength IS NULL OR abs(mr.memory_strength - scored.strength) > 0.001)
    `);
    metrics.strength_rows_updated = strengthResult.rowCount ?? 0;

    const archiveLowStrength = await client.query(`
      UPDATE ${schema}.memory_records mr
      SET lifecycle_status = 'archived',
          is_current = false,
          archived_at = COALESCE(archived_at, now()),
          invalid_at = COALESCE(invalid_at, now()),
          fact_status = 'historical',
          memory_layer = 'archival',
          updated_at = now(),
          updated_by = 'memory:consolidate',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'governance_action', 'archive_low_strength',
            'governance_applied_at', now()
          )
      WHERE mr.is_current IS TRUE
        AND mr.lifecycle_status = 'approved'
        AND COALESCE(mr.memory_strength, 1.0) < 0.25
        AND COALESCE(mr.last_accessed_at, mr.updated_at, mr.created_at) < now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.memory_relations rel
          WHERE (rel.memory_id = mr.id OR rel.related_memory_id = mr.id)
            AND rel.relation_type IN ('supports', 'refines', 'same_as', 'derived_from')
        )
    `);
    metrics.archived_low_strength = archiveLowStrength.rowCount ?? 0;

    const episodeInsert = await client.query(`
      WITH eligible AS (
        SELECT
          id,
          scope_type,
          scope_id,
          COALESCE(NULLIF(source_ref, ''), COALESCE(metadata->>'source', 'unknown')) AS source_key,
          date_trunc('day', COALESCE(observed_at, created_at)) AS day_bucket,
          created_at,
          updated_at
        FROM ${schema}.memory_records
        WHERE episode_id IS NULL
          AND is_current IS TRUE
          AND lifecycle_status IN ('approved', 'candidate')
      ),
      grouped AS (
        SELECT
          md5(scope_type || ':' || scope_id || ':' || source_key || ':' || day_bucket::text) AS consolidation_key,
          scope_type,
          scope_id,
          source_key,
          day_bucket,
          min(created_at) AS started_at,
          max(updated_at) AS ended_at,
          count(*) AS record_count
        FROM eligible
        GROUP BY scope_type, scope_id, source_key, day_bucket
        HAVING count(*) >= 2
        LIMIT 500
      )
      INSERT INTO ${schema}.memory_episodes (title, description, occurred_at, ended_at, metadata)
      SELECT
        'Episode ' || scope_type || ':' || scope_id || ' ' || day_bucket::date,
        'Consolidated memory-xx episode from ' || record_count || ' records',
        started_at,
        ended_at,
        jsonb_build_object(
          'consolidation_key', consolidation_key,
          'scope_type', scope_type,
          'scope_id', scope_id,
          'source_ref', source_key,
          'record_count', record_count,
          'builder', 'memory:consolidate'
        )
      FROM grouped g
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_episodes e
        WHERE e.metadata->>'consolidation_key' = g.consolidation_key
      )
    `);
    metrics.episodes_created = episodeInsert.rowCount ?? 0;

    const episodeLink = await client.query(`
      WITH eligible AS (
        SELECT
          id,
          scope_type,
          scope_id,
          COALESCE(NULLIF(source_ref, ''), COALESCE(metadata->>'source', 'unknown')) AS source_key,
          date_trunc('day', COALESCE(observed_at, created_at)) AS day_bucket
        FROM ${schema}.memory_records
        WHERE episode_id IS NULL
          AND is_current IS TRUE
          AND lifecycle_status IN ('approved', 'candidate')
      ),
      keyed AS (
        SELECT
          id,
          md5(scope_type || ':' || scope_id || ':' || source_key || ':' || day_bucket::text) AS consolidation_key
        FROM eligible
      )
      UPDATE ${schema}.memory_records mr
      SET episode_id = e.id
      FROM keyed k
      JOIN ${schema}.memory_episodes e ON e.metadata->>'consolidation_key' = k.consolidation_key
      WHERE mr.id = k.id AND mr.episode_id IS NULL
    `);
    metrics.episode_links_created = episodeLink.rowCount ?? 0;

    const entityInsert = await client.query(`
      WITH candidates AS (
        SELECT DISTINCT
          CASE
            WHEN memory_type IN ('preference', 'constraint', 'procedure', 'fact', 'decision') THEN 'memory_topic'
            ELSE 'scope'
          END AS entity_type,
          left(regexp_replace(COALESCE(NULLIF(metadata->>'topic', ''), NULLIF(title, ''), scope_id), '\\s+', ' ', 'g'), 120) AS name
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status IN ('approved', 'candidate')
      ),
      cleaned AS (
        SELECT entity_type, name, lower(name) AS canonical_name
        FROM candidates
        WHERE name IS NOT NULL AND length(trim(name)) >= 2
      )
      INSERT INTO ${schema}.memory_entities (entity_type, name, canonical_name, metadata)
      SELECT entity_type, name, canonical_name, jsonb_build_object('source', 'memory:consolidate')
      FROM cleaned c
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_entities e
        WHERE e.entity_type = c.entity_type AND e.canonical_name = c.canonical_name
      )
      LIMIT 1000
    `);
    metrics.entities_created = entityInsert.rowCount ?? 0;

    const entityLink = await client.query(`
      WITH candidates AS (
        SELECT
          mr.id AS memory_id,
          CASE
            WHEN mr.memory_type IN ('preference', 'constraint', 'procedure', 'fact', 'decision') THEN 'memory_topic'
            ELSE 'scope'
          END AS entity_type,
          lower(left(regexp_replace(COALESCE(NULLIF(mr.metadata->>'topic', ''), NULLIF(mr.title, ''), mr.scope_id), '\\s+', ' ', 'g'), 120)) AS canonical_name
        FROM ${schema}.memory_records mr
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status IN ('approved', 'candidate')
      ),
      links AS (
        SELECT e.id AS entity_id, c.memory_id
        FROM candidates c
        JOIN ${schema}.memory_entities e
          ON e.entity_type = c.entity_type
         AND e.canonical_name = c.canonical_name
      )
      INSERT INTO ${schema}.memory_entity_links (entity_id, memory_id, role, confidence)
      SELECT entity_id, memory_id, 'subject', 0.8
      FROM links l
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_entity_links existing
        WHERE existing.entity_id = l.entity_id AND existing.memory_id = l.memory_id
      )
      LIMIT 2000
    `);
    metrics.entity_links_created = entityLink.rowCount ?? 0;

    const supportRelations = await client.query(`
      WITH ranked AS (
        SELECT
          id,
          episode_id,
          first_value(id) OVER (PARTITION BY episode_id ORDER BY memory_strength DESC, updated_at DESC, id ASC) AS anchor_id
        FROM ${schema}.memory_records
        WHERE episode_id IS NOT NULL
          AND is_current IS TRUE
          AND lifecycle_status IN ('approved', 'candidate')
      )
      INSERT INTO ${schema}.memory_relations (
        id,
        memory_id,
        related_memory_id,
        relation_type,
        direction,
        weight,
        metadata,
        relation_metadata
      )
      SELECT
        'relation_consolidation_' || md5(anchor_id || ':' || id),
        anchor_id,
        id,
        'supports',
        'bidirectional',
        0.4,
        jsonb_build_object('source', 'memory:consolidate'),
        jsonb_build_object('episode_relation', true)
      FROM ranked
      WHERE id <> anchor_id
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.memory_relations rel
          WHERE rel.id = 'relation_consolidation_' || md5(ranked.anchor_id || ':' || ranked.id)
        )
      LIMIT 1000
    `);
    metrics.support_relations_created = supportRelations.rowCount ?? 0;

    const summary = await client.query(`
      SELECT
        count(*)::int AS records,
        count(*) FILTER (WHERE memory_strength IS DISTINCT FROM 1.0)::int AS non_default_strength,
        count(*) FILTER (WHERE memory_layer <> 'recall')::int AS non_recall_layer,
        (SELECT count(*)::int FROM ${schema}.memory_episodes) AS episodes,
        (SELECT count(*)::int FROM ${schema}.memory_entities) AS entities,
        (SELECT count(*)::int FROM ${schema}.memory_entity_links) AS entity_links
      FROM ${schema}.memory_records
    `);

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    console.log(JSON.stringify({
      ok: true,
      dry_run: dryRun,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      schema: config.dbSchema,
      metrics,
      summary: summary.rows[0],
    }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await closePool(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
