import { Pool } from "pg";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { buildGraphDebtBackfillScopePredicate } from "../app/governance/graph-debt-backfill-policy";

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env;
}

function loadScriptEnv(): NodeJS.ProcessEnv {
  const fileEnv = readEnvFile(process.env.MEMORY_XX_ENV_PATH || join(process.cwd(), ".env"));
  return { ...fileEnv, ...process.env };
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

function parseFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseIntArg(name: string, fallback: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function applyBackfill(pool: Pool, schema: string): Promise<Record<string, number>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const metadataSource = await client.query(`
      UPDATE ${schema}.memory_records mr
      SET metadata = COALESCE(mr.metadata, '{}'::jsonb) || jsonb_build_object(
            'source',
            CASE
              WHEN COALESCE(NULLIF(mr.source_kind, ''), '') <> '' AND COALESCE(NULLIF(mr.source_ref, ''), '') <> ''
                THEN mr.source_kind || ':' || mr.source_ref
              WHEN COALESCE(NULLIF(mr.source_kind, ''), '') <> ''
                THEN mr.source_kind
              WHEN COALESCE(NULLIF(mr.source_ref, ''), '') <> ''
                THEN mr.source_ref
              WHEN COALESCE(NULLIF(mr.metadata->>'source_type', ''), '') <> ''
                THEN mr.metadata->>'source_type'
              WHEN COALESCE(NULLIF(mr.created_by, ''), '') <> ''
                THEN 'created_by:' || mr.created_by
              ELSE 'unknown'
            END,
            'source_backfilled_by', 'memory:debt-plan',
            'source_backfilled_at', now()
          ),
          updated_at = now(),
          updated_by = 'memory:debt-plan'
      WHERE mr.is_current IS TRUE
        AND mr.lifecycle_status = 'approved'
        AND (mr.metadata->>'source' IS NULL OR mr.metadata->>'source' = '')
    `);

    const entityInsert = await client.query(`
      WITH candidates AS (
        SELECT DISTINCT
          CASE
            WHEN mr.memory_type IN ('preference', 'constraint', 'procedure', 'fact', 'decision') THEN 'memory_topic'
            ELSE 'scope'
          END AS entity_type,
          left(regexp_replace(COALESCE(NULLIF(mr.metadata->>'topic', ''), NULLIF(mr.title, ''), mr.scope_id), '\\s+', ' ', 'g'), 120) AS name
        FROM ${schema}.memory_records mr
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id
          )
      ),
      cleaned AS (
        SELECT entity_type, name, lower(name) AS canonical_name
        FROM candidates
        WHERE name IS NOT NULL AND length(trim(name)) >= 2
      )
      INSERT INTO ${schema}.memory_entities (entity_type, name, canonical_name, metadata)
      SELECT entity_type, name, canonical_name, jsonb_build_object('source', 'memory:debt-plan', 'backfill', 'graph_entity')
      FROM cleaned c
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_entities e
        WHERE e.entity_type = c.entity_type AND e.canonical_name = c.canonical_name
      )
    `);

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
          AND mr.lifecycle_status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id
          )
      ),
      links AS (
        SELECT e.id AS entity_id, c.memory_id
        FROM candidates c
        JOIN ${schema}.memory_entities e
          ON e.entity_type = c.entity_type
         AND e.canonical_name = c.canonical_name
      )
      INSERT INTO ${schema}.memory_entity_links (entity_id, memory_id, role, confidence)
      SELECT entity_id, memory_id, 'debt_backfill_subject', 0.7
      FROM links l
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_entity_links existing
        WHERE existing.entity_id = l.entity_id AND existing.memory_id = l.memory_id
      )
    `);

    const episodeInsert = await client.query(`
      WITH eligible AS (
        SELECT
          id,
          scope_type,
          scope_id,
          COALESCE(NULLIF(source_ref, ''), NULLIF(metadata->>'source', ''), NULLIF(created_by, ''), 'unknown') AS source_key,
          date_trunc('day', COALESCE(observed_at, created_at)) AS day_bucket,
          created_at,
          updated_at
        FROM ${schema}.memory_records
        WHERE episode_id IS NULL
          AND is_current IS TRUE
          AND lifecycle_status = 'approved'
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
      )
      INSERT INTO ${schema}.memory_episodes (title, description, occurred_at, ended_at, metadata)
      SELECT
        'Debt backfill episode ' || scope_type || ':' || scope_id || ' ' || day_bucket::date,
        'Report-only debt backfill converted to reviewed structural episode for ' || record_count || ' records',
        started_at,
        ended_at,
        jsonb_build_object(
          'consolidation_key', consolidation_key,
          'scope_type', scope_type,
          'scope_id', scope_id,
          'source_ref', source_key,
          'record_count', record_count,
          'builder', 'memory:debt-plan',
          'backfill', 'graph_episode'
        )
      FROM grouped g
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_episodes e
        WHERE e.metadata->>'consolidation_key' = g.consolidation_key
      )
    `);

    const episodeLink = await client.query(`
      WITH eligible AS (
        SELECT
          id,
          scope_type,
          scope_id,
          COALESCE(NULLIF(source_ref, ''), NULLIF(metadata->>'source', ''), NULLIF(created_by, ''), 'unknown') AS source_key,
          date_trunc('day', COALESCE(observed_at, created_at)) AS day_bucket
        FROM ${schema}.memory_records
        WHERE episode_id IS NULL
          AND is_current IS TRUE
          AND lifecycle_status = 'approved'
      ),
      keyed AS (
        SELECT
          id,
          md5(scope_type || ':' || scope_id || ':' || source_key || ':' || day_bucket::text) AS consolidation_key
        FROM eligible
      )
      UPDATE ${schema}.memory_records mr
      SET episode_id = e.id,
          updated_at = now(),
          updated_by = 'memory:debt-plan'
      FROM keyed k
      JOIN ${schema}.memory_episodes e ON e.metadata->>'consolidation_key' = k.consolidation_key
      WHERE mr.id = k.id AND mr.episode_id IS NULL
    `);

    const supportRelations = await client.query(`
      WITH ranked AS (
        SELECT
          id,
          episode_id,
          first_value(id) OVER (PARTITION BY episode_id ORDER BY memory_strength DESC NULLS LAST, updated_at DESC, id ASC) AS anchor_id
        FROM ${schema}.memory_records
        WHERE episode_id IS NOT NULL
          AND is_current IS TRUE
          AND lifecycle_status = 'approved'
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
        'relation_debt_episode_' || md5(anchor_id || ':' || id),
        anchor_id,
        id,
        'supports',
        'bidirectional',
        0.35,
        jsonb_build_object('source', 'memory:debt-plan', 'backfill', 'graph_relation'),
        jsonb_build_object('episode_relation', true, 'backfill', 'graph_relation')
      FROM ranked
      WHERE id <> anchor_id
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.memory_relations rel
          WHERE rel.memory_id = ranked.id OR rel.related_memory_id = ranked.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.memory_relations rel
          WHERE rel.id = 'relation_debt_episode_' || md5(ranked.anchor_id || ':' || ranked.id)
        )
    `);

    const selfRelations = await client.query(`
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
        'relation_debt_self_' || md5(mr.id),
        mr.id,
        mr.id,
        'self_context',
        'bidirectional',
        0.1,
        jsonb_build_object('source', 'memory:debt-plan', 'backfill', 'graph_relation_self'),
        jsonb_build_object('self_relation', true, 'backfill', 'graph_relation')
      FROM ${schema}.memory_records mr
      WHERE mr.is_current IS TRUE
        AND mr.lifecycle_status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.memory_relations rel
          WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${schema}.memory_relations rel
          WHERE rel.id = 'relation_debt_self_' || md5(mr.id)
        )
    `);

    await client.query("COMMIT");
    return {
      metadata_source_backfilled: metadataSource.rowCount ?? 0,
      entities_created: entityInsert.rowCount ?? 0,
      entity_links_created: entityLink.rowCount ?? 0,
      episodes_created: episodeInsert.rowCount ?? 0,
      episode_links_created: episodeLink.rowCount ?? 0,
      support_relations_created: supportRelations.rowCount ?? 0,
      self_relations_created: selfRelations.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function applyConservativeBackfill(
  pool: Pool,
  schema: string,
  limit: number,
  options: { readonly productionOnly: boolean },
): Promise<Record<string, number>> {
  const client = await pool.connect();
  const requiredProvenancePredicate = buildGraphDebtBackfillScopePredicate("mr", {
    productionOnly: options.productionOnly,
    relationTable: `${schema}.memory_relations`,
    excludeRelationDebt: false,
  });
  const graphStructurePredicate = buildGraphDebtBackfillScopePredicate("mr", {
    productionOnly: options.productionOnly,
    relationTable: `${schema}.memory_relations`,
  });
  try {
    await client.query("BEGIN");

    const requiredProvenance = await client.query(`
      WITH eligible AS (
        SELECT mr.id
        FROM ${schema}.memory_records mr
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND mr.review_state IN ('approved', 'not_required')
          AND ${requiredProvenancePredicate}
          AND (
            mr.source_kind IS NULL OR mr.source_kind = ''
            OR mr.source_ref IS NULL OR mr.source_ref = ''
            OR mr.dedupe_key IS NULL OR mr.dedupe_key = ''
            OR mr.signature_hash IS NULL OR mr.signature_hash = ''
          )
        ORDER BY mr.updated_at DESC
        LIMIT $1
      )
      UPDATE ${schema}.memory_records mr
      SET source_kind = COALESCE(
            NULLIF(mr.source_kind, ''),
            left(COALESCE(
              NULLIF(mr.metadata->>'source_type', ''),
              NULLIF(mr.metadata->>'source', ''),
              NULLIF(mr.created_by, ''),
              'conservative_backfill'
            ), 120)
          ),
          source_ref = COALESCE(
            NULLIF(mr.source_ref, ''),
            CASE
              WHEN COALESCE(NULLIF(mr.request_id, ''), '') <> '' THEN 'request:' || mr.request_id
              ELSE 'memory:' || mr.id
            END
          ),
          dedupe_key = COALESCE(
            NULLIF(mr.dedupe_key, ''),
            md5(concat_ws('||',
              COALESCE(mr.scope_type, ''),
              COALESCE(mr.scope_id, ''),
              COALESCE(mr.memory_type, ''),
              regexp_replace(lower(trim(COALESCE(mr.title, ''))), '\\s+', ' ', 'g'),
              regexp_replace(lower(trim(COALESCE(mr.content, ''))), '\\s+', ' ', 'g')
            ))
          ),
          signature_hash = COALESCE(
            NULLIF(mr.signature_hash, ''),
            md5(concat_ws('||',
              COALESCE(mr.scope_type, ''),
              COALESCE(mr.scope_id, ''),
              COALESCE(mr.memory_type, ''),
              regexp_replace(lower(trim(COALESCE(mr.title, ''))), '\\s+', ' ', 'g'),
              regexp_replace(lower(trim(COALESCE(mr.content, ''))), '\\s+', ' ', 'g'),
              COALESCE(NULLIF(mr.dedupe_key, ''), '')
            ))
          ),
          metadata = COALESCE(mr.metadata, '{}'::jsonb) || jsonb_build_object(
            'provenance_backfilled_at', now(),
            'provenance_backfilled_by', 'memory:debt-plan:conservative',
            'provenance_backfill_reason', 'l14_required_fields_missing'
          ),
          updated_at = now(),
          updated_by = 'memory:debt-plan:conservative'
      FROM eligible
      WHERE mr.id = eligible.id
    `, [limit]);

    const metadataSource = await client.query(`
      WITH eligible AS (
        SELECT
          mr.id,
          CASE
            WHEN COALESCE(NULLIF(mr.source_kind, ''), '') <> '' AND COALESCE(NULLIF(mr.source_ref, ''), '') <> ''
              THEN mr.source_kind || ':' || mr.source_ref
            WHEN COALESCE(NULLIF(mr.source_ref, ''), '') <> ''
              THEN mr.source_ref
            WHEN COALESCE(NULLIF(mr.source_kind, ''), '') <> ''
              THEN mr.source_kind
            WHEN COALESCE(NULLIF(mr.metadata->>'canonical_source_path', ''), '') <> ''
              THEN mr.metadata->>'canonical_source_path'
            WHEN COALESCE(NULLIF(mr.metadata->>'source_path', ''), '') <> ''
              THEN mr.metadata->>'source_path'
            WHEN COALESCE(NULLIF(mr.metadata->>'source_ref', ''), '') <> ''
              THEN mr.metadata->>'source_ref'
            WHEN COALESCE(NULLIF(mr.metadata->>'uri', ''), '') <> ''
              THEN mr.metadata->>'uri'
            WHEN COALESCE(NULLIF(mr.metadata->>'source_type', ''), '') <> ''
              THEN mr.metadata->>'source_type'
            WHEN COALESCE(NULLIF(mr.created_by, ''), '') <> ''
              THEN 'created_by:' || mr.created_by
            ELSE NULL
          END AS source_value
        FROM ${schema}.memory_records mr
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND ${requiredProvenancePredicate}
          AND (mr.metadata->>'source' IS NULL OR mr.metadata->>'source' = '')
        ORDER BY mr.updated_at DESC
        LIMIT $1
      )
      UPDATE ${schema}.memory_records mr
      SET metadata = COALESCE(mr.metadata, '{}'::jsonb) || jsonb_build_object(
            'source', eligible.source_value,
            'source_backfilled_by', 'memory:debt-plan:conservative',
            'source_backfilled_at', now()
          ),
          updated_at = now(),
          updated_by = 'memory:debt-plan:conservative'
      FROM eligible
      WHERE mr.id = eligible.id
        AND eligible.source_value IS NOT NULL
        AND eligible.source_value <> ''
    `, [limit]);

    const entityInsert = await client.query(`
      WITH eligible AS (
        SELECT DISTINCT
          CASE
            WHEN mr.memory_type IN ('preference', 'constraint', 'procedure', 'fact', 'decision') THEN 'memory_topic'
            ELSE 'scope'
          END AS entity_type,
          left(regexp_replace(COALESCE(NULLIF(mr.metadata->>'topic', ''), NULLIF(mr.title, ''), mr.scope_id), '\\s+', ' ', 'g'), 120) AS name
        FROM ${schema}.memory_records mr
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND ${graphStructurePredicate}
          AND COALESCE(NULLIF(mr.metadata->>'source', ''), NULLIF(mr.source_ref, ''), NULLIF(mr.source_kind, '')) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id
          )
        ORDER BY name
        LIMIT $1
      ),
      cleaned AS (
        SELECT entity_type, name, lower(name) AS canonical_name
        FROM eligible
        WHERE name IS NOT NULL AND length(trim(name)) >= 2
      )
      INSERT INTO ${schema}.memory_entities (entity_type, name, canonical_name, metadata)
      SELECT entity_type, name, canonical_name, jsonb_build_object('source', 'memory:debt-plan:conservative', 'backfill', 'graph_entity')
      FROM cleaned c
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_entities e
        WHERE e.entity_type = c.entity_type AND e.canonical_name = c.canonical_name
      )
    `, [limit]);

    const entityLink = await client.query(`
      WITH eligible AS (
        SELECT
          mr.id AS memory_id,
          CASE
            WHEN mr.memory_type IN ('preference', 'constraint', 'procedure', 'fact', 'decision') THEN 'memory_topic'
            ELSE 'scope'
          END AS entity_type,
          lower(left(regexp_replace(COALESCE(NULLIF(mr.metadata->>'topic', ''), NULLIF(mr.title, ''), mr.scope_id), '\\s+', ' ', 'g'), 120)) AS canonical_name
        FROM ${schema}.memory_records mr
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND ${graphStructurePredicate}
          AND COALESCE(NULLIF(mr.metadata->>'source', ''), NULLIF(mr.source_ref, ''), NULLIF(mr.source_kind, '')) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id
          )
        ORDER BY mr.updated_at DESC
        LIMIT $1
      ),
      links AS (
        SELECT e.id AS entity_id, c.memory_id
        FROM eligible c
        JOIN ${schema}.memory_entities e
          ON e.entity_type = c.entity_type
         AND e.canonical_name = c.canonical_name
      )
      INSERT INTO ${schema}.memory_entity_links (entity_id, memory_id, role, confidence)
      SELECT entity_id, memory_id, 'debt_backfill_subject', 0.75
      FROM links l
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_entity_links existing
        WHERE existing.entity_id = l.entity_id AND existing.memory_id = l.memory_id
      )
    `, [limit]);

    const episodeInsert = await client.query(`
      WITH eligible AS (
        SELECT
          mr.id,
          mr.scope_type,
          mr.scope_id,
          COALESCE(NULLIF(mr.metadata->>'source', ''), NULLIF(mr.source_ref, ''), NULLIF(mr.source_kind, '')) AS source_key,
          date_trunc('day', COALESCE(mr.observed_at, mr.created_at)) AS day_bucket,
          mr.created_at,
          mr.updated_at
        FROM ${schema}.memory_records mr
        WHERE mr.episode_id IS NULL
              AND ${graphStructurePredicate}
          AND mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND COALESCE(NULLIF(mr.metadata->>'source', ''), NULLIF(mr.source_ref, ''), NULLIF(mr.source_kind, '')) IS NOT NULL
        ORDER BY mr.updated_at DESC
        LIMIT $1
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
      )
      INSERT INTO ${schema}.memory_episodes (title, description, occurred_at, ended_at, metadata)
      SELECT
        'Conservative debt backfill episode ' || scope_type || ':' || scope_id || ' ' || day_bucket::date,
        'Conservative provenance backfill grouped ' || record_count || ' records with clear source metadata',
        started_at,
        ended_at,
        jsonb_build_object(
          'consolidation_key', consolidation_key,
          'scope_type', scope_type,
          'scope_id', scope_id,
          'source_ref', source_key,
          'record_count', record_count,
          'builder', 'memory:debt-plan:conservative',
          'backfill', 'graph_episode'
        )
      FROM grouped g
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.memory_episodes e
        WHERE e.metadata->>'consolidation_key' = g.consolidation_key
      )
    `, [limit]);

    const episodeLink = await client.query(`
      WITH eligible AS (
        SELECT
          mr.id,
          mr.scope_type,
          mr.scope_id,
          COALESCE(NULLIF(mr.metadata->>'source', ''), NULLIF(mr.source_ref, ''), NULLIF(mr.source_kind, '')) AS source_key,
          date_trunc('day', COALESCE(mr.observed_at, mr.created_at)) AS day_bucket
        FROM ${schema}.memory_records mr
        WHERE mr.episode_id IS NULL
              AND ${graphStructurePredicate}
          AND mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND COALESCE(NULLIF(mr.metadata->>'source', ''), NULLIF(mr.source_ref, ''), NULLIF(mr.source_kind, '')) IS NOT NULL
        ORDER BY mr.updated_at DESC
        LIMIT $1
      ),
      keyed AS (
        SELECT
          id,
          md5(scope_type || ':' || scope_id || ':' || source_key || ':' || day_bucket::text) AS consolidation_key
        FROM eligible
      )
      UPDATE ${schema}.memory_records mr
      SET episode_id = e.id,
          updated_at = now(),
          updated_by = 'memory:debt-plan:conservative'
      FROM keyed k
      JOIN ${schema}.memory_episodes e ON e.metadata->>'consolidation_key' = k.consolidation_key
      WHERE mr.id = k.id AND mr.episode_id IS NULL
    `, [limit]);

    await client.query("COMMIT");
    return {
      required_provenance_backfilled: requiredProvenance.rowCount ?? 0,
      metadata_source_backfilled: metadataSource.rowCount ?? 0,
      entities_created: entityInsert.rowCount ?? 0,
      entity_links_created: entityLink.rowCount ?? 0,
      episodes_created: episodeInsert.rowCount ?? 0,
      episode_links_created: episodeLink.rowCount ?? 0,
      support_relations_created: 0,
      self_relations_created: 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function applyRequiredProvenanceBackfill(
  pool: Pool,
  schema: string,
  limit: number,
  options: { readonly productionOnly: boolean },
): Promise<Record<string, number>> {
  const client = await pool.connect();
  const productionPredicate = buildGraphDebtBackfillScopePredicate("mr", {
    productionOnly: options.productionOnly,
    relationTable: `${schema}.memory_relations`,
    excludeRelationDebt: false,
  });
  try {
    await client.query("BEGIN");
    const requiredProvenance = await client.query(`
      WITH eligible AS (
        SELECT mr.id
        FROM ${schema}.memory_records mr
        WHERE mr.is_current IS TRUE
          AND mr.lifecycle_status = 'approved'
          AND mr.review_state IN ('approved', 'not_required')
          AND ${productionPredicate}
          AND (
            mr.source_kind IS NULL OR mr.source_kind = ''
            OR mr.source_ref IS NULL OR mr.source_ref = ''
            OR mr.dedupe_key IS NULL OR mr.dedupe_key = ''
            OR mr.signature_hash IS NULL OR mr.signature_hash = ''
          )
        ORDER BY mr.updated_at DESC
        LIMIT $1
      )
      UPDATE ${schema}.memory_records mr
      SET source_kind = COALESCE(
            NULLIF(mr.source_kind, ''),
            left(COALESCE(
              NULLIF(mr.metadata->>'source_type', ''),
              NULLIF(mr.metadata->>'source', ''),
              NULLIF(mr.created_by, ''),
              'required_provenance_backfill'
            ), 120)
          ),
          source_ref = COALESCE(
            NULLIF(mr.source_ref, ''),
            CASE
              WHEN COALESCE(NULLIF(mr.request_id, ''), '') <> '' THEN 'request:' || mr.request_id
              ELSE 'memory:' || mr.id
            END
          ),
          dedupe_key = COALESCE(
            NULLIF(mr.dedupe_key, ''),
            md5(concat_ws('||',
              COALESCE(mr.scope_type, ''),
              COALESCE(mr.scope_id, ''),
              COALESCE(mr.memory_type, ''),
              regexp_replace(lower(trim(COALESCE(mr.title, ''))), '\\s+', ' ', 'g'),
              regexp_replace(lower(trim(COALESCE(mr.content, ''))), '\\s+', ' ', 'g')
            ))
          ),
          signature_hash = COALESCE(
            NULLIF(mr.signature_hash, ''),
            md5(concat_ws('||',
              COALESCE(mr.scope_type, ''),
              COALESCE(mr.scope_id, ''),
              COALESCE(mr.memory_type, ''),
              regexp_replace(lower(trim(COALESCE(mr.title, ''))), '\\s+', ' ', 'g'),
              regexp_replace(lower(trim(COALESCE(mr.content, ''))), '\\s+', ' ', 'g'),
              COALESCE(NULLIF(mr.dedupe_key, ''), '')
            ))
          ),
          metadata = COALESCE(mr.metadata, '{}'::jsonb) || jsonb_build_object(
            'provenance_backfilled_at', now(),
            'provenance_backfilled_by', 'memory:debt-plan:required-provenance',
            'provenance_backfill_reason', 'l14_required_fields_missing'
          ),
          updated_at = now(),
          updated_by = 'memory:debt-plan:required-provenance'
      FROM eligible
      WHERE mr.id = eligible.id
    `, [limit]);
    await client.query("COMMIT");
    return {
      required_provenance_backfilled: requiredProvenance.rowCount ?? 0,
      metadata_source_backfilled: 0,
      entities_created: 0,
      entity_links_created: 0,
      episodes_created: 0,
      episode_links_created: 0,
      support_relations_created: 0,
      self_relations_created: 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadMemoryXXPostgresConfig(loadScriptEnv());
  const schema = quoteIdent(config.schema);
  const apply = parseFlag("--apply");
  const applyConservative = parseFlag("--apply-conservative");
  const applyRequiredProvenance = parseFlag("--apply-required-provenance");
  const includeTestOnly = parseFlag("--include-test-only");
  const limit = parseIntArg("--limit", 50);
  const pool = new Pool(createPostgresPoolConfig(config));
  const provenanceReportPredicate = buildGraphDebtBackfillScopePredicate("mr", {
    productionOnly: !includeTestOnly,
    relationTable: `${schema}.memory_relations`,
    excludeRelationDebt: false,
  });
  const graphReportPredicate = buildGraphDebtBackfillScopePredicate("mr", {
    productionOnly: !includeTestOnly,
    relationTable: `${schema}.memory_relations`,
      });
      try {
        const applyMetrics = applyRequiredProvenance
      ? await applyRequiredProvenanceBackfill(pool, schema, limit, { productionOnly: !includeTestOnly })
      : applyConservative
          ? await applyConservativeBackfill(pool, schema, limit, { productionOnly: !includeTestOnly })
          : apply
            ? await applyBackfill(pool, schema)
            : undefined;
    const requiredProvenance = await pool.query(`
      SELECT
        mr.id,
        mr.scope_type,
        mr.scope_id,
        mr.title,
        mr.source_kind,
        mr.source_ref,
        (mr.dedupe_key IS NULL OR mr.dedupe_key = '') AS missing_dedupe_key,
        (mr.signature_hash IS NULL OR mr.signature_hash = '') AS missing_signature_hash,
        mr.created_by,
        mr.agent_id,
        mr.request_id,
        mr.metadata->>'source' AS metadata_source,
        mr.metadata->>'source_type' AS metadata_source_type
      FROM ${schema}.memory_records mr
      WHERE mr.is_current IS TRUE
        AND mr.lifecycle_status = 'approved'
        AND mr.review_state IN ('approved', 'not_required')
        AND ${provenanceReportPredicate}
        AND (
          mr.source_kind IS NULL OR mr.source_kind = ''
          OR mr.source_ref IS NULL OR mr.source_ref = ''
          OR mr.dedupe_key IS NULL OR mr.dedupe_key = ''
          OR mr.signature_hash IS NULL OR mr.signature_hash = ''
        )
      ORDER BY mr.updated_at DESC
      LIMIT $1
    `, [limit]);

    const missingMetadata = await pool.query(`
      SELECT mr.id, mr.scope_type, mr.scope_id, mr.title, mr.source_kind, mr.source_ref, mr.metadata->>'source' AS metadata_source
      FROM ${schema}.memory_records mr
      WHERE mr.is_current IS TRUE
        AND mr.lifecycle_status = 'approved'
        AND ${provenanceReportPredicate}
        AND (mr.metadata->>'source' IS NULL OR mr.metadata->>'source' = '')
      ORDER BY mr.updated_at DESC
      LIMIT $1
    `, [limit]);

    const graphOrphans = await pool.query(`
      SELECT
        mr.id,
        mr.scope_type,
        mr.scope_id,
        mr.title,
        (mr.episode_id IS NULL) AS missing_episode,
        NOT EXISTS (SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id) AS missing_entity_link,
        NOT EXISTS (SELECT 1 FROM ${schema}.memory_relations rel WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id) AS missing_relation
      FROM ${schema}.memory_records mr
      WHERE mr.is_current IS TRUE
        AND mr.lifecycle_status = 'approved'
        AND ${graphReportPredicate}
        AND (
          mr.episode_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id)
          OR NOT EXISTS (SELECT 1 FROM ${schema}.memory_relations rel WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id)
        )
      ORDER BY mr.updated_at DESC
      LIMIT $1
    `, [limit]);

    process.stdout.write(JSON.stringify({
      ok: true,
      mode: applyRequiredProvenance ? "applied_required_provenance" : applyConservative ? "applied_conservative" : apply ? "applied" : "report_only",
      checked_at: new Date().toISOString(),
      schema: config.schema,
      limit,
      apply_metrics: applyMetrics,
      actions: [
        applyRequiredProvenance
          ? includeTestOnly
            ? "Required provenance backfill applied, including test-only lanes by explicit request; no content, relation, episode, or entity mutation was performed."
            : "Required provenance backfill applied for production lanes only; no content, relation, episode, or entity mutation was performed."
          : applyConservative
          ? includeTestOnly
            ? "Conservative backfill applied from clear provenance, including test-only lanes by explicit request; no relation was auto-created."
            : "Conservative backfill applied from clear provenance for production lanes only; no relation was auto-created."
          : apply
            ? "Legacy broad backfill applied; rerun memory:doctor and graph recall gates."
            : "Review missing_metadata_source candidates and backfill metadata.source from source_kind/source_ref only when provenance is clear.",
        applyRequiredProvenance || applyConservative || apply
          ? "Backfill did not delete, archive, tombstone, or rewrite memory content."
          : "Use --apply-conservative for source/episode/entity-link backfill only; relation debt remains review-only.",
          ],
      required_provenance: requiredProvenance.rows,
      missing_metadata_source: missingMetadata.rows,
      graph_orphans: graphOrphans.rows,
    }, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
