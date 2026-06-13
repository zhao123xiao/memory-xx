import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Pool } from "pg";

import {
  createPostgresPoolConfig,
  loadMemoryXXPostgresConfig,
  quoteIdentifier,
  runPostgresMigrations
} from "../app";

type JsonObject = Record<string, unknown>;

type NormalizedRecord = {
  record_id: string;
  request_id: string;
  scope_type: string;
  scope_id: string;
  content: string;
  title: string | null;
  summary: string | null;
  metadata: JsonObject;
  dedupe_key: string | null;
  lifecycle_status: string;
  review_state: string;
  is_current: boolean;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  decision: "allow" | "hold" | "exclude";
};

type SourceMapping = {
  source_id: string;
  memory_id: string;
  source_type: string;
  uri: string | null;
  excerpt: string | null;
  confidence: number | null;
  captured_at: string | null;
  metadata: JsonObject;
  decision: "allow" | "hold" | "exclude";
};

type RelationMapping = {
  relation_id: string;
  memory_id: string;
  related_memory_id: string;
  relation_type: string;
  direction?: "outbound" | "bidirectional";
  weight?: number | null;
  metadata?: JsonObject;
  decision: "allow" | "hold" | "exclude";
};

type EventMapping = {
  event_id: string;
  memory_id: string;
  request_id: string;
  event_type: string;
  actor_id: string;
  payload: JsonObject;
  created_at: string;
  decision: "allow" | "hold" | "exclude";
};

type IngestRequest = {
  request_id: string;
  command_type: string;
  payload_hash: string;
  payload_json: JsonObject;
  actor_id: string;
  status: string;
  decision: "allow" | "hold" | "exclude";
};

type DatasetManifest = {
  batch_id: string;
  counts: Record<string, number>;
};

async function loadJsonl<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

async function main(): Promise<void> {
  const batchDir = process.argv[2];
  if (!batchDir) {
    throw new Error("Usage: node --import tsx scripts/import-staging-batch.ts <batch-dir>");
  }

  const resolvedBatchDir = path.resolve(process.cwd(), batchDir);
  const config = loadMemoryXXPostgresConfig(process.env);
  await runPostgresMigrations({
    config,
    migrationsDirectory: path.resolve(process.cwd(), "migrations")
  });

  const manifest = JSON.parse(
    await fs.readFile(path.join(resolvedBatchDir, "dataset-manifest.json"), "utf8")
  ) as DatasetManifest;
  const records = (await loadJsonl<NormalizedRecord>(
    path.join(resolvedBatchDir, "normalized-records.jsonl")
  )).filter((row) => row.decision === "allow");
  const sources = (await loadJsonl<SourceMapping>(
    path.join(resolvedBatchDir, "source-mapping.jsonl")
  )).filter((row) => row.decision === "allow");
  const relations = (await loadJsonl<RelationMapping>(
    path.join(resolvedBatchDir, "relation-mapping.jsonl")
  )).filter((row) => row.decision === "allow");
  const events = (await loadJsonl<EventMapping>(
    path.join(resolvedBatchDir, "event-mapping.jsonl")
  )).filter((row) => row.decision === "allow");
  const requests = (await loadJsonl<IngestRequest>(
    path.join(resolvedBatchDir, "ingest-requests.jsonl")
  )).filter((row) => row.decision === "allow");

  const pool = new Pool(createPostgresPoolConfig(config));
  const schema = quoteIdentifier(config.schema);
  const importedAt = new Date().toISOString();

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET search_path TO ${schema}, public`);

      const existing = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_records"
      );
      if (Number(existing.rows[0]?.count ?? "0") > 0) {
        throw new Error(
          `Target schema ${config.schema} is not empty; aborting staging import to avoid mixed batches.`
        );
      }

      for (const request of requests) {
        await client.query(
          `
            INSERT INTO ingest_requests (
              request_id,
              command_type,
              payload_hash,
              payload_json,
              actor_id,
              status,
              first_seen_at,
              last_seen_at,
              completed_at,
              result_json,
              error_code,
              error_message
            )
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::jsonb, NULL, NULL)
          `,
          [
            request.request_id,
            request.command_type,
            request.payload_hash,
            JSON.stringify(request.payload_json),
            request.actor_id,
            request.status,
            importedAt,
            importedAt,
            importedAt,
            JSON.stringify({
              imported: true,
              batchId: manifest.batch_id,
              requestId: request.request_id
            })
          ]
        );
      }

      for (const record of records) {
        await client.query(
          `
            INSERT INTO memory_records (
              id,
              request_id,
              scope_type,
              scope_id,
              content,
              title,
              summary,
              metadata,
              dedupe_key,
              lifecycle_status,
              review_state,
              is_current,
              version,
              created_by,
              updated_by,
              created_at,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::timestamptz
            )
          `,
          [
            record.record_id,
            record.request_id,
            record.scope_type,
            record.scope_id,
            record.content,
            record.title,
            record.summary,
            JSON.stringify(record.metadata ?? {}),
            record.dedupe_key,
            record.lifecycle_status,
            record.review_state,
            record.is_current,
            record.version,
            record.created_by,
            record.updated_by,
            record.created_at,
            record.updated_at
          ]
        );
      }

      for (const source of sources) {
        await client.query(
          `
            INSERT INTO memory_sources (
              id,
              memory_id,
              source_type,
              uri,
              excerpt,
              confidence,
              captured_at,
              metadata,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb, $9::timestamptz, $10::timestamptz)
          `,
          [
            source.source_id,
            source.memory_id,
            source.source_type,
            source.uri,
            source.excerpt,
            source.confidence,
            source.captured_at,
            JSON.stringify(source.metadata ?? {}),
            importedAt,
            importedAt
          ]
        );
      }

      for (const relation of relations) {
        await client.query(
          `
            INSERT INTO memory_relations (
              id,
              memory_id,
              related_memory_id,
              relation_type,
              direction,
              weight,
              metadata,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)
          `,
          [
            relation.relation_id,
            relation.memory_id,
            relation.related_memory_id,
            relation.relation_type,
            relation.direction ?? "outbound",
            relation.weight ?? null,
            JSON.stringify(relation.metadata ?? {}),
            importedAt,
            importedAt
          ]
        );
      }

      for (const event of events) {
        await client.query(
          `
            INSERT INTO memory_events (
              id,
              memory_id,
              request_id,
              event_type,
              actor_id,
              payload,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
          `,
          [
            event.event_id,
            event.memory_id,
            event.request_id,
            event.event_type,
            event.actor_id,
            JSON.stringify(event.payload ?? {}),
            event.created_at
          ]
        );
      }

      const auditRows = [
        ["ingest_requests", requests.length],
        ["memory_records", records.length],
        ["memory_sources", sources.length],
        ["memory_relations", relations.length],
        ["memory_events", events.length]
      ] as const;

      for (const [tableName, rowCount] of auditRows) {
        await client.query(
          `
            INSERT INTO migration_audit (
              id,
              request_id,
              target_table,
              target_id,
              batch_id,
              action,
              details,
              created_at
            )
            VALUES ($1, NULL, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
          `,
          [
            `migration_audit_${randomUUID()}`,
            tableName,
            `${manifest.batch_id}:${tableName}`,
            manifest.batch_id,
            "staging_import_summary",
            JSON.stringify({
              schema: config.schema,
              importedRows: rowCount,
              importedAt
            }),
            importedAt
          ]
        );
      }

      await client.query("COMMIT");

      const countsResult = await client.query<{
        ingest_requests: string;
        memory_records: string;
        memory_sources: string;
        memory_relations: string;
        memory_events: string;
        migration_audit: string;
      }>(`
        SELECT
          (SELECT COUNT(*)::text FROM ingest_requests) AS ingest_requests,
          (SELECT COUNT(*)::text FROM memory_records) AS memory_records,
          (SELECT COUNT(*)::text FROM memory_sources) AS memory_sources,
          (SELECT COUNT(*)::text FROM memory_relations) AS memory_relations,
          (SELECT COUNT(*)::text FROM memory_events) AS memory_events,
          (SELECT COUNT(*)::text FROM migration_audit) AS migration_audit
      `);

      const counts = countsResult.rows[0];
      process.stdout.write(
        `${JSON.stringify(
          {
            batchId: manifest.batch_id,
            schema: config.schema,
            databaseUrl: config.databaseUrl,
            importedAt,
            expectedAllow: manifest.counts.records_allow,
            actual: counts
          },
          null,
          2
        )}\n`
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
