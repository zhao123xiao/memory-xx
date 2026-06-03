/**
 * Backfill script: Qdrant legacy points → PG shared truth layer
 *
 * Reads all points from Qdrant collection "memory-xx", deduplicates by memory_id,
 * and inserts into PG tables: ingest_requests → memory_records → memory_events → outbox_events
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/backfill-qdrant-to-pg.ts
 */
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const QDRANT_BASE = process.env.MEMORY_V2_QDRANT_BASE_URL ?? "http://127.0.0.1:6333";
const QDRANT_COLLECTION = process.env.MEMORY_V2_QDRANT_COLLECTION ?? "memory-xx";
const DATABASE_URL = process.env.MEMORY_V2_DATABASE_URL!;
const BATCH_SIZE = 100;

if (!DATABASE_URL) {
  console.error("MEMORY_V2_DATABASE_URL is required");
  process.exit(1);
}

interface QdrantPoint {
  id: string;
  payload: Record<string, unknown>;
  vector?: number[];
}

async function scrollAllPoints(): Promise<QdrantPoint[]> {
  const allPoints: QdrantPoint[] = [];
  let offset: string | undefined;

  while (true) {
    const url = `${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points/scroll`;
    const body: Record<string, unknown> = {
      limit: BATCH_SIZE,
      with_payload: true,
      with_vector: false,
    };
    if (offset) body.offset = offset;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Qdrant scroll failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json() as { result: { points: QdrantPoint[]; next_page_offset?: string } };
    const points = data.result.points ?? [];
    allPoints.push(...points);
    console.log(`  Fetched ${points.length} points (total: ${allPoints.length})`);

    offset = data.result.next_page_offset;
    if (!offset || points.length === 0) break;
  }
  return allPoints;
}

async function main() {
  console.log("=== Qdrant → PG Backfill ===");
  console.log(`Qdrant: ${QDRANT_BASE}/collections/${QDRANT_COLLECTION}`);
  console.log(`PG: ${DATABASE_URL.replace(/:[^:@]+@/, ":****@")}`);

  // 1. Fetch all Qdrant points
  console.log("\n[1/4] Fetching Qdrant points...");
  const rawPoints = await scrollAllPoints();
  console.log(`  Total points fetched: ${rawPoints.length}`);

  // 2. Deduplicate by memory_id (keep latest by updated_at)
  const byMemoryId = new Map<string, QdrantPoint>();
  for (const point of rawPoints) {
    const mid = String(point.payload.memory_id ?? "");
    if (!mid) continue;
    const existing = byMemoryId.get(mid);
    if (!existing) {
      byMemoryId.set(mid, point);
    } else {
      const existingTs = String(existing.payload.updated_at ?? existing.payload.created_at ?? "");
      const currentTs = String(point.payload.updated_at ?? point.payload.created_at ?? "");
      if (currentTs > existingTs) {
        byMemoryId.set(mid, point);
      }
    }
  }
  const dedupedPoints = [...byMemoryId.values()];
  console.log(`  After dedup: ${dedupedPoints.length} unique memories (removed ${rawPoints.length - dedupedPoints.length} duplicates)`);

  // 3. Connect to PG
  console.log("\n[2/4] Connecting to PG...");
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check existing data
    const { rows: [{ cnt: existingCount }] } = await client.query("SELECT COUNT(*) as cnt FROM memory_records");
    if (Number(existingCount) > 0) {
      console.log(`  PG already has ${existingCount} records. Skipping backfill (idempotent).`);
      await client.query("COMMIT");
      return;
    }

    // 4. Insert in batches
    console.log(`\n[3/4] Inserting ${dedupedPoints.length} records into PG...`);
    let inserted = 0;
    let skipped = 0;

    for (const point of dedupedPoints) {
      const p = point.payload;
      const memoryId = String(p.memory_id ?? "");
      const scopeType = String(p.scope_type ?? "workspace");

      // Validate scope_type against CHECK constraint
      const validScopeTypes = ["user", "project", "workspace", "global"];
      if (!validScopeTypes.includes(scopeType)) {
        console.log(`  SKIP ${memoryId}: invalid scope_type="${scopeType}"`);
        skipped++;
        continue;
      }

      // Validate lifecycle_status
      const lifecycleStatus = String(p.lifecycle_status ?? "approved");
      const validStatuses = ["candidate", "approved", "rejected", "archived", "superseded", "tombstone"];
      if (!validStatuses.includes(lifecycleStatus)) {
        console.log(`  SKIP ${memoryId}: invalid lifecycle_status="${lifecycleStatus}"`);
        skipped++;
        continue;
      }

      // Validate review_state
      const reviewState = String(p.review_state ?? "not_required");
      const validReviewStates = ["pending", "approved", "not_required", "rejected"];
      if (!validReviewStates.includes(reviewState)) {
        console.log(`  SKIP ${memoryId}: invalid review_state="${reviewState}"`);
        skipped++;
        continue;
      }

      const requestId = String(p.request_id ?? `backfill:${memoryId}`);
      const scopeId = String(p.scope_id ?? "current-instance");
      const content = String(p.content ?? "");
      const title = p.title ? String(p.title) : null;
      const summary = p.summary ? String(p.summary) : null;
      const createdBy = String(p.created_by ?? "backfill-script");
      const updatedAt = String(p.updated_at ?? p.created_at ?? new Date().toISOString());
      const createdAt = String(p.created_at ?? updatedAt);

      // Build metadata (remove internal fields)
      const metadata: Record<string, unknown> = {};
      if (p.metadata && typeof p.metadata === "object") {
        Object.assign(metadata, p.metadata as Record<string, unknown>);
      }
      // Preserve useful Qdrant payload fields in metadata
      for (const key of ["category", "memory_type", "section", "canonical_section", "canonical_source_path", "source_path", "source_type", "tags", "entity_names"]) {
        if (p[key] !== undefined) metadata[key] = p[key];
      }

      // ingest_requests
      await client.query(`
        INSERT INTO ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, first_seen_at, last_seen_at, completed_at, result_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (request_id) DO NOTHING
      `, [
        requestId,
        "memory.create",
        `backfill:${memoryId}`,
        JSON.stringify({ memory_id: memoryId, source: "qdrant_backfill" }),
        createdBy,
        "completed",
        createdAt,
        updatedAt,
        updatedAt,
        JSON.stringify({ memory_id: memoryId }),
      ]);

      // memory_records
      await client.query(`
        INSERT INTO memory_records (id, request_id, scope_type, scope_id, content, title, summary, metadata, dedupe_key, lifecycle_status, review_state, is_current, version, created_by, updated_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (id) DO NOTHING
      `, [
        memoryId,
        requestId,
        scopeType,
        scopeId,
        content,
        title,
        summary,
        JSON.stringify(metadata),
        null,
        lifecycleStatus,
        reviewState,
        Boolean(p.is_current ?? true),
        Number(p.version ?? 1),
        createdBy,
        createdBy,
        createdAt,
        updatedAt,
      ]);

      // memory_events
      const eventId = `memory_event_${randomUUID()}`;
      await client.query(`
        INSERT INTO memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        eventId,
        memoryId,
        requestId,
        "migration.shadow.loaded",
        "backfill-script",
        JSON.stringify({ source: "qdrant_backfill", original_payload_keys: Object.keys(p) }),
        createdAt,
      ]);

      // outbox_events
      const outboxId = `outbox_event_${randomUUID()}`;
      await client.query(`
        INSERT INTO outbox_events (id, aggregate_id, request_id, event_type, payload, payload_version, dispatch_status, attempts, created_at, dispatched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        outboxId,
        memoryId,
        requestId,
        "migration.shadow.loaded",
        JSON.stringify({ memory_id: memoryId, scope_type: scopeType, scope_id: scopeId }),
        1,
        "dispatched",
        1,
        createdAt,
        updatedAt,
      ]);

      // memory_sources (if present in payload)
      const sources = p.sources;
      if (Array.isArray(sources)) {
        for (let i = 0; i < Math.min(sources.length, 5); i++) {
          const src = sources[i] as Record<string, unknown>;
          if (!src || typeof src !== "object") continue;
          await client.query(`
            INSERT INTO memory_sources (id, memory_id, source_type, uri, excerpt, confidence, captured_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT DO NOTHING
          `, [
            `source_${memoryId}_${i}`,
            memoryId,
            String(src.source_type ?? "unknown"),
            src.uri ? String(src.uri) : null,
            src.excerpt ? String(src.excerpt).substring(0, 2000) : null,
            src.confidence ? Number(src.confidence) : null,
            createdAt,
            JSON.stringify({}),
          ]);
        }
      }

      inserted++;
      if (inserted % 50 === 0) {
        console.log(`  Progress: ${inserted}/${dedupedPoints.length} inserted`);
      }
    }

    await client.query("COMMIT");
    console.log(`\n[4/4] Done! Inserted: ${inserted}, Skipped: ${skipped}`);

    // Verify
    const { rows: stats } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM memory_records) as records,
        (SELECT COUNT(*) FROM ingest_requests) as requests,
        (SELECT COUNT(*) FROM memory_events) as events,
        (SELECT COUNT(*) FROM outbox_events) as outbox,
        (SELECT COUNT(*) FROM memory_sources) as sources
    `);
    console.log("\n=== PG Stats After Backfill ===");
    console.log(`  memory_records:  ${stats[0].records}`);
    console.log(`  ingest_requests: ${stats[0].requests}`);
    console.log(`  memory_events:   ${stats[0].events}`);
    console.log(`  outbox_events:   ${stats[0].outbox}`);
    console.log(`  memory_sources:  ${stats[0].sources}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
