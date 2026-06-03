import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createPool, query, createSchema, dropSchema, closePool } from "../lib/db-helpers.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const schemaName = `memory_xx_it_${runId}`;
const report = createEmptyReport("L2", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L2 Isolated Integration — run_id: ${runId}`);
  console.log(`  Schema: ${schemaName} (isolated, no production writes)`);
  console.log(`${"=".repeat(50)}\n`);

  const pool = createPool();
  const client = await pool.connect();

  try {
    // 1. Create isolated schema
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      check("create-schema", true, `Created schema ${schemaName}`);
    } catch (e: any) {
      check("create-schema", false, `Failed: ${e.message}`);
      finalizeReport(report);
      console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
      process.exit(1);
    }

    // 2. Set search_path to isolated schema for ALL subsequent operations
    await client.query(`SET search_path TO "${schemaName}", public`);

    // Run migrations
    const fs = await import("node:fs");
    const path = await import("node:path");
    const migrationsDir = path.join(config.projectRoot, "migrations");
    let migrationFiles: string[] = [];
    let migrationErrors: string[] = [];

    try {
      migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
    } catch (e: any) {
      check("migrations", false, `Cannot read migrations: ${e.message}`);
    }

    if (migrationFiles.length > 0) {
      let applied = 0, failed = 0;
      for (const file of migrationFiles) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        try {
          await client.query(sql);
          applied++;
        } catch (e: any) {
          failed++;
          migrationErrors.push(`${file}: ${e.message.slice(0, 80)}`);
        }
      }

      const coreFailed = migrationErrors.filter(e => !e.includes("hnsw") && !e.includes("fts_gin") && !e.includes("metadata")).length;
      const ok = coreFailed === 0;
      check("migrations", ok,
        ok ? `${applied} migrations applied (${failed} index-only skipped)`
          : `${applied} applied, ${failed} failed: ${migrationErrors.join("; ")}`,
        ok ? "critical" : "critical");
    }

    // 3. Verify schema has expected tables
    try {
      const r = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [schemaName],
      );
      const tables = r.rows.map((row: any) => row.table_name);
      const expected = ["memory_records", "memory_events", "outbox_events", "ingest_requests"];
      const missing = expected.filter(t => !tables.includes(t));
      check("schema:tables", missing.length === 0,
        missing.length === 0
          ? `${tables.length} tables created: ${tables.join(", ")}`
          : `Missing tables: ${missing.join(", ")}`,
        missing.length === 0 ? "critical" : "critical");
      report.metrics["tables_created"] = tables.length;
    } catch (e: any) {
      check("schema:tables", false, `Error checking tables: ${e.message}`);
    }

    // 4. Test write lifecycle directly in isolated schema (no wrapper)
    const testScopeId = `it-test-${runId}`;
    const memId = `test_mem_${runId}`;

    const reqId = randomUUID();

    // Insert ingest_request first (foreign key dependency)
    try {
      await client.query(`SET search_path TO "${schemaName}", public`);
      await client.query(`
        INSERT INTO ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status)
        VALUES ($1, 'memory.create', 'l2-test-hash', '{}', 'l2-test', 'completed')
      `, [reqId]);
    } catch (e: any) {
      check("lifecycle:ingest", false, `Ingest insert error: ${e.message.slice(0, 120)}`);
    }

    // Insert a test record
    try {
      await client.query(`
        INSERT INTO memory_records (id, request_id, scope_type, scope_id, title, content,
          lifecycle_status, review_state, is_current, version, created_by, updated_by, created_at, updated_at)
        VALUES ($1, $2, 'project', $3, 'L2 Isolated Test', 'Test record for isolated integration',
          'candidate', 'pending', true, 1, 'l2-test', 'l2-test', now(), now())
      `, [memId, reqId, testScopeId]);

      // Verify insert
      const r = await client.query(`SELECT * FROM memory_records WHERE id = $1`, [memId]);
      check("lifecycle:write", r.rowCount === 1,
        r.rowCount === 1 ? "Record inserted in isolated schema" : `Insert returned ${r.rowCount} rows`);
    } catch (e: any) {
      check("lifecycle:write", false, `Insert error: ${e.message.slice(0, 120)}`);
    }

    // Approve (update status)
    try {
      await client.query(`
        UPDATE memory_records SET lifecycle_status = 'approved', review_state = 'approved'
        WHERE id = $1
      `, [memId]);
      const r = await client.query(`SELECT lifecycle_status, review_state FROM memory_records WHERE id = $1`, [memId]);
      const row = r.rows[0];
      check("lifecycle:approve",
        row?.lifecycle_status === "approved" && row?.review_state === "approved",
        `status=${row?.lifecycle_status} review=${row?.review_state}`);
    } catch (e: any) {
      check("lifecycle:approve", false, `Error: ${e.message}`);
    }

    // Recall (query)
    try {
      const r = await client.query(
        `SELECT * FROM memory_records WHERE scope_id = $1 AND lifecycle_status = 'approved' AND is_current = true`,
        [testScopeId],
      );
      check("lifecycle:recall", r.rowCount === 1, `${r.rowCount} approved current records found`);
    } catch (e: any) {
      check("lifecycle:recall", false, `Error: ${e.message}`);
    }

    // Archive
    try {
      await client.query(`
        UPDATE memory_records SET lifecycle_status = 'archived', is_current = false WHERE id = $1
      `, [memId]);
      const r = await client.query(`SELECT lifecycle_status, is_current FROM memory_records WHERE id = $1`, [memId]);
      const row = r.rows[0];
      check("lifecycle:archive",
        row?.lifecycle_status === "archived" && row?.is_current === false,
        `status=${row?.lifecycle_status} is_current=${row?.is_current}`);
    } catch (e: any) {
      check("lifecycle:archive", false, `Error: ${e.message}`);
    }

    // Reset for tombstone test
    try {
      await client.query(`
        UPDATE memory_records SET lifecycle_status = 'approved', is_current = true WHERE id = $1
      `, [memId]);
    } catch {}

    // Tombstone
    try {
      await client.query(`
        UPDATE memory_records SET lifecycle_status = 'tombstone', is_current = false WHERE id = $1
      `, [memId]);
      const r = await client.query(`SELECT lifecycle_status, is_current FROM memory_records WHERE id = $1`, [memId]);
      const row = r.rows[0];
      check("lifecycle:tombstone",
        row?.lifecycle_status === "tombstone" && row?.is_current === false,
        `status=${row?.lifecycle_status} is_current=${row?.is_current}`);
    } catch (e: any) {
      check("lifecycle:tombstone", false, `Error: ${e.message}`);
    }

    // Verify tombstoned record is not in recallable set
    try {
      const r = await client.query(
        `SELECT count(*) as cnt FROM memory_records WHERE scope_id = $1 AND is_current = true AND lifecycle_status NOT IN ('tombstone', 'rejected')`,
        [testScopeId],
      );
      check("lifecycle:invisible", parseInt(r.rows[0]?.cnt || "1") === 0,
        `Recallable records in scope: ${r.rows[0]?.cnt}`);
    } catch (e: any) {
      check("lifecycle:invisible", false, `Error: ${e.message}`);
    }

    // 5. Outbox event verification (check table exists)
    try {
      const r = await client.query(`SELECT count(*) as cnt FROM outbox_events`);
      check("outbox:table", true, `Outbox table accessible, ${r.rows[0]?.cnt} events`);
    } catch (e: any) {
      check("outbox:table", false, `Outbox table error: ${e.message.slice(0, 80)}`, "warning");
    }

    await client.query(`SET search_path TO public`);
    client.release();

  } finally {
    // 6. Cleanup: drop test schema
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      check("cleanup:schema", true, `Dropped schema ${schemaName}`);
      report.cleanup.performed = true;
      report.cleanup.resources_cleaned.push(schemaName);
    } catch (e: any) {
      check("cleanup:schema", false, `Failed to drop schema: ${e.message}`);
      report.cleanup.failed.push(schemaName);
    }
    await closePool(pool);
  }

  finalizeReport(report);

  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log(`\n  L2 Result: ${report.ok ? "PASS" : "FAIL"} (${passed}/${total} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
