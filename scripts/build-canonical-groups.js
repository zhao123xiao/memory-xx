#!/usr/bin/env node
/**
 * Canonical Memory Builder — scans existing memories and groups duplicates.
 *
 * Strategy:
 *   1. For each approved/is_current memory, compute title_norm and content_hash.
 *   2. Group by title_norm: records with identical normalized title are semantic duplicates.
 *   3. Pick representative: prefer project scope > workspace > global; newer > older.
 *   4. Write to memory_canonical_groups + memory_canonical_members.
 *
 * Usage:
 *   sudo node scripts/build-canonical-groups.js [--dry-run] [--debug]
 */

import process from "node:process";
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const DB_URL = process.env.MEMORY_XX_DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/memory_xx";
const SCHEMA = process.env.MEMORY_XX_DATABASE_SCHEMA || "memory_xx";
const dryRun = process.argv.includes("--dry-run");
const debug = process.argv.includes("--debug");

function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^\w一-鿿]/g, "")
    .trim();
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content || "").digest("hex").slice(0, 16);
}

function scopePriority(scopeType) {
  const order = { project: 0, workspace: 1, shared: 2, global: 3, personal: 4, execution: 5, task: 6 };
  return order[scopeType] ?? 99;
}

function pickRepresentative(records) {
  // Sort: current first, then scope priority, then newer first
  const sorted = [...records].sort((a, b) => {
    if (a.is_current !== b.is_current) return b.is_current ? -1 : 1;
    const spA = scopePriority(a.scope_type);
    const spB = scopePriority(b.scope_type);
    if (spA !== spB) return spA - spB;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return sorted[0];
}

async function main() {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
  console.log(`Canonical Group Builder`);
  console.log(`Schema: ${SCHEMA}, Dry-run: ${dryRun}\n`);

  // Fetch all approved/is_current records
  const { rows: records } = await pool.query(
    `SELECT id, title, content, scope_type, scope_id, lifecycle_status, is_current, created_at
     FROM ${SCHEMA}.memory_records
     WHERE lifecycle_status = 'approved' AND is_current = true
     ORDER BY created_at ASC`
  );
  console.log(`Loaded ${records.length} active approved records`);

  // Compute normalized titles and group
  const groups = new Map(); // normTitle -> records[]
  let singletons = 0;

  for (const rec of records) {
    const norm = normalizeTitle(rec.title);
    if (!norm || norm.length < 2) { singletons++; continue; }
    rec._title_norm = norm;
    rec._content_hash = contentHash(rec.content);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(rec);
  }

  // Find duplicate groups (2+ records)
  let groupsCreated = 0;
  let membersCreated = 0;

  const client = await pool.connect();
  if (!dryRun) await client.query("BEGIN");

  try {
    for (const [normTitle, recs] of groups) {
      if (recs.length < 2) continue;

      const rep = pickRepresentative(recs);
      const canonicalId = `cg_${normTitle.slice(0, 40)}_${recs[0]._content_hash}`;

      if (debug) {
        console.log(`  Group "${normTitle.slice(0, 50)}": ${recs.length} records -> rep=${rep.id.slice(0, 20)}...`);
      }

      if (!dryRun) {
        await client.query(
          `INSERT INTO ${SCHEMA}.memory_canonical_groups (canonical_id, representative_memory_id, content_hash, title_norm, group_type)
           VALUES ($1, $2, $3, $4, 'semantic_duplicate')
           ON CONFLICT (canonical_id) DO UPDATE SET representative_memory_id = $2, updated_at = now()`,
          [canonicalId, rep.id, rep._content_hash, normTitle]
        );

        for (const rec of recs) {
          await client.query(
            `INSERT INTO ${SCHEMA}.memory_canonical_members (canonical_id, memory_id, scope_type, scope_id, lifecycle_status, is_current, reason)
             VALUES ($1, $2, $3, $4, $5, $6, 'auto_grouped')
             ON CONFLICT (canonical_id, memory_id) DO UPDATE SET is_current = $6, lifecycle_status = $5`,
            [canonicalId, rec.id, rec.scope_type, rec.scope_id, rec.lifecycle_status, rec.is_current]
          );
          membersCreated++;
        }
      }
      groupsCreated++;
    }

    if (!dryRun) await client.query("COMMIT");
  } catch (e) {
    if (!dryRun) await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  console.log(`\nResults:`);
  console.log(`  Total records: ${records.length}`);
  console.log(`  Unique titles: ${groups.size}`);
  console.log(`  Duplicate groups (2+): ${groupsCreated}`);
  console.log(`  Members grouped: ${membersCreated}`);
  console.log(`  Singletons: ${singletons + (groups.size - groupsCreated - [...groups.values()].filter(g => g.length >= 2).length)}`);
  if (dryRun) console.log(`  (dry-run, no changes written)`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
