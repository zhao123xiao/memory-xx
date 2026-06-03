import "./test-harness/config.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";
import { buildPolicyCompareObservations, type PolicyCorpusSample } from "../app/governance/policy-corpus";

interface Args {
  readonly json: boolean;
  readonly writeObservations: boolean;
  readonly compareSampleSize: number;
  readonly runId: string;
}

function readArg(name: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (inline !== undefined) return inline;
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function parseArgs(): Args {
  const compareSampleSize = Number.parseInt(readArg("compare-sample-size") || "20", 10);
  return {
    json: process.argv.includes("--json"),
    writeObservations: process.argv.includes("--write-observations"),
    compareSampleSize: Number.isFinite(compareSampleSize) && compareSampleSize > 0 ? compareSampleSize : 20,
    runId: readArg("run-id") || "memory-benchmark-10k-v1",
  };
}

async function loadNormalizedPolicyCorpus(limit: number): Promise<PolicyCorpusSample[]> {
  const path = join(process.cwd(), "data", "policy-corpus", "normalized", "policy-corpus.jsonl");
  const raw = await readFile(path, "utf8");
  return raw.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => JSON.parse(line) as PolicyCorpusSample);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config = loadMemoryV2PostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const schema = config.schema;
    const before = await pool.query(
      `SELECT count(*)::int AS observations,
              coalesce(avg(confidence_diff), 0)::float8 AS avg_confidence_diff,
              coalesce(max(observed_at), null) AS latest_observed_at
         FROM ${quoteIdent(schema)}.intelligence_compare_observations
        WHERE observed_at >= now() - interval '24 hours'`
    );
    const existing = Number(before.rows[0]?.observations ?? 0);
    const needed = Math.max(0, args.compareSampleSize - existing);
    let inserted = 0;
    if (args.writeObservations && needed > 0) {
      const samples = await loadNormalizedPolicyCorpus(needed);
      const observations = buildPolicyCompareObservations(samples, {
        runId: args.runId,
        sampleSize: needed,
      });
      for (const observation of observations) {
        await pool.query(
          `INSERT INTO ${quoteIdent(schema)}.intelligence_compare_observations (
             id, observed_at, primary_model, fallback_model,
             primary_latency_ms, fallback_latency_ms,
             primary_schema_valid, fallback_schema_valid,
             memory_count_diff, confidence_diff, metadata
           )
           VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [
            `intelligence_compare_observation_${randomUUID()}`,
            observation.observedAt,
            observation.primaryModel,
            observation.fallbackModel,
            observation.primaryLatencyMs,
            observation.fallbackLatencyMs,
            observation.primarySchemaValid,
            observation.fallbackSchemaValid,
            observation.memoryCountDiff,
            observation.confidenceDiff,
            JSON.stringify(observation.metadata),
          ]
        );
        inserted += 1;
      }
    }
    const result = await pool.query(
      `SELECT count(*)::int AS observations,
              coalesce(avg(confidence_diff), 0)::float8 AS avg_confidence_diff,
              coalesce(max(observed_at), null) AS latest_observed_at
         FROM ${quoteIdent(schema)}.intelligence_compare_observations
        WHERE observed_at >= now() - interval '24 hours'`
    );
    const row = result.rows[0] ?? {};
    const payload = {
      ok: Number(row.observations ?? 0) >= args.compareSampleSize,
      run_id: args.runId,
      compare_sample_size: args.compareSampleSize,
      existing_observations_24h: existing,
      inserted_observations: inserted,
      write_observations: args.writeObservations,
      ...row,
    };
    process.stdout.write(`${JSON.stringify(payload, null, args.json ? 2 : 0)}\n`);
  } finally {
    await pool.end();
  }
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
