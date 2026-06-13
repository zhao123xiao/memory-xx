#!/usr/bin/env tsx
import "./test-harness/config.js";

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";

import {
  buildKnowledgeMarkdownManifest,
  buildKnowledgeMarkdownRows,
  classifyMarkdownDocuments,
  executeMarkdownArchivePlan,
  scanMarkdownFiles,
  type KnowledgeMarkdownManifest,
  type KnowledgeMarkdownRows,
  type MarkdownCandidate,
  type MarkdownGovernanceCurrentState,
  type MarkdownManifestEntry,
} from "../app/knowledge/markdown-governance";
import { loadMemoryXXPostgresConfig, createPostgresPoolConfig } from "../app/db/adapters/postgres-config";
import { OpenAICompatibleEmbeddingProvider } from "../app/server/embedding-provider";

type Command = "scan" | "classify" | "ingest" | "archive";

interface ParsedArgs {
  readonly command: Command;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly writeReport: boolean;
  readonly withQdrant: boolean;
  readonly includeImportCurrent: boolean;
  readonly skipStateProbe: boolean;
  readonly root: string;
  readonly reportDir: string;
  readonly archiveRoot: string;
  readonly runId: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly currentStateFile: string | null;
}

interface StateProbeResult extends MarkdownGovernanceCurrentState {
  readonly probes: Record<string, { readonly ok: boolean; readonly error?: string }>;
}

interface IngestResult {
  readonly documents: number;
  readonly chunks: number;
  readonly postgres_written: boolean;
  readonly qdrant: {
    readonly requested: boolean;
    readonly ok: boolean;
    readonly collection: string;
    readonly points_upserted: number;
    readonly degraded_reason?: string;
  };
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function parsePositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(argValue(name) ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseCommand(): Command {
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (command === "scan" || command === "classify" || command === "ingest" || command === "archive") return command;
  throw new Error("Usage: npm run memory:knowledge-md -- <scan|classify|ingest|archive> [--dry-run|--apply] [--json]");
}

function safeTimestamp(value = new Date().toISOString()): string {
  return value.replace(/[:.]/gu, "-");
}

function parseArgs(): ParsedArgs {
  const apply = hasFlag("--apply");
  return {
    command: parseCommand(),
    json: hasFlag("--json"),
    dryRun: hasFlag("--dry-run") || !apply,
    apply,
    writeReport: hasFlag("--write-report"),
    withQdrant: hasFlag("--with-qdrant"),
    includeImportCurrent: hasFlag("--include-import-current"),
    skipStateProbe: hasFlag("--skip-state-probe"),
    root: path.resolve(argValue("--root") ?? "<linux-user-home>"),
    reportDir: path.resolve(argValue("--report-dir") ?? path.join(process.cwd(), "reports", "knowledge-md")),
    archiveRoot: path.resolve(argValue("--archive-root") ?? path.join(os.homedir(), ".memory-xx-knowledge-archive")),
    runId: argValue("--run-id") ?? `knowledge-md-${safeTimestamp()}`,
    maxFiles: parsePositiveInt("--max-files", 5000),
    maxBytes: parsePositiveInt("--max-bytes", 512 * 1024),
    timeoutMs: parsePositiveInt("--probe-timeout-ms", 15_000),
    currentStateFile: argValue("--current-state-file"),
  };
}

function hashEmbedding(values: readonly number[]): string {
  return createHash("sha256").update(values.map((value) => Number(value).toPrecision(8)).join(",")).digest("hex");
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return `"${value}"`;
}

function stripContent(candidate: MarkdownCandidate): Omit<MarkdownCandidate, "content"> {
  const { content: _content, ...rest } = candidate;
  return rest;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedBoolean(input: Record<string, unknown> | null, paths: readonly string[][]): boolean | null {
  for (const keys of paths) {
    let current: unknown = input;
    for (const key of keys) current = jsonObject(current)?.[key];
    const value = readBoolean(current);
    if (value !== null) return value;
  }
  return null;
}

function nestedNumber(input: Record<string, unknown> | null, paths: readonly string[][]): number | null {
  for (const keys of paths) {
    let current: unknown = input;
    for (const key of keys) current = jsonObject(current)?.[key];
    const value = readNumber(current);
    if (value !== null) return value;
  }
  return null;
}

async function runJsonNpmScript(script: string, args: readonly string[], timeoutMs: number): Promise<{
  readonly ok: boolean;
  readonly data: Record<string, unknown> | null;
  readonly error?: string;
}> {
  return await new Promise((resolve) => {
    const child = spawn("npm", ["run", script, "--", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, data: null, error: `timeout_after_${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const start = stdout.indexOf("{");
      const end = stdout.lastIndexOf("}");
      const jsonText = start >= 0 && end >= start ? stdout.slice(start, end + 1) : "";
      try {
        const parsed = jsonText ? JSON.parse(jsonText) : null;
        resolve({ ok: code === 0, data: jsonObject(parsed), error: code === 0 ? undefined : stderr.trim() || `exit_${code}` });
      } catch (error) {
        resolve({ ok: false, data: null, error: error instanceof Error ? error.message : String(error) });
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, data: null, error: error.message });
    });
  });
}

async function loadCurrentState(args: ParsedArgs): Promise<StateProbeResult> {
  if (args.skipStateProbe) {
    return {
      now: new Date().toISOString(),
      runtimeOk: false,
      candidateCurrent: 0,
      qdrantDrift: false,
      p1GatePass: false,
      productionGuardOk: false,
      probes: { skipped: { ok: true } },
    };
  }

  if (args.currentStateFile) {
    const parsed = await import("node:fs/promises").then((fs) => fs.readFile(args.currentStateFile!, "utf8")).then(JSON.parse);
    const object = jsonObject(parsed);
    return {
      now: typeof object?.now === "string" ? object.now : new Date().toISOString(),
      runtimeOk: readBoolean(object?.runtimeOk) ?? readBoolean(object?.runtime_ok) ?? false,
      candidateCurrent: readNumber(object?.candidateCurrent) ?? readNumber(object?.candidate_current) ?? 0,
      qdrantDrift: readBoolean(object?.qdrantDrift) ?? readBoolean(object?.qdrant_drift) ?? false,
      p1GatePass: readBoolean(object?.p1GatePass) ?? readBoolean(object?.p1_gate_pass) ?? false,
      productionGuardOk: readBoolean(object?.productionGuardOk) ?? readBoolean(object?.production_guard_ok) ?? false,
      probes: { current_state_file: { ok: true } },
    };
  }

  const [status, pending, qdrant, p1, guard] = await Promise.all([
    runJsonNpmScript("memory:status", ["--json"], args.timeoutMs),
    runJsonNpmScript("memory:pending", ["--json"], args.timeoutMs),
    runJsonNpmScript("memory:qdrant-reconcile", ["--json"], args.timeoutMs),
    runJsonNpmScript("memory:p1-gate", ["--json"], args.timeoutMs),
    runJsonNpmScript("memory:auto-approval", ["production-guard", "--json"], args.timeoutMs),
  ]);

  const statusData = status.data;
  const pendingData = pending.data;
  const qdrantData = qdrant.data;
  const p1Data = p1.data;
  const guardData = guard.data;
  const stale = nestedNumber(qdrantData, [["stale_count"], ["stale"], ["summary", "stale"], ["counts", "stale"]]) ?? 0;
  const missing = nestedNumber(qdrantData, [["missing_count"], ["missing"], ["summary", "missing"], ["counts", "missing"]]) ?? 0;
  const payloadDrift = nestedNumber(qdrantData, [["payload_drift_count"], ["payload_drift"], ["summary", "payload_drift"], ["counts", "payload_drift"]]) ?? 0;
  const orphan = nestedNumber(qdrantData, [["orphan_count"], ["orphan"], ["summary", "orphan"], ["counts", "orphan"]]) ?? 0;

  return {
    now: new Date().toISOString(),
    runtimeOk: nestedBoolean(statusData, [["runtime_ok"], ["runtime", "ok"], ["summary", "runtime_ok"]]) ?? status.ok,
    candidateCurrent: nestedNumber(pendingData, [["candidate_current"], ["summary", "candidate_current"], ["counts", "candidate_current"]]) ?? 0,
    qdrantDrift: missing + stale + payloadDrift + orphan > 0,
    p1GatePass: nestedBoolean(p1Data, [["ok"], ["pass"], ["passed"]]) ?? p1.ok,
    productionGuardOk: nestedBoolean(guardData, [["ok"], ["production_guard_ok"]]) ?? guard.ok,
    probes: {
      status: { ok: status.ok, ...(status.error ? { error: status.error } : {}) },
      pending: { ok: pending.ok, ...(pending.error ? { error: pending.error } : {}) },
      qdrant_reconcile: { ok: qdrant.ok, ...(qdrant.error ? { error: qdrant.error } : {}) },
      p1_gate: { ok: p1.ok, ...(p1.error ? { error: p1.error } : {}) },
      production_guard: { ok: guard.ok, ...(guard.error ? { error: guard.error } : {}) },
    },
  };
}

async function writeManifestReport(args: ParsedArgs, manifest: KnowledgeMarkdownManifest): Promise<string> {
  const dir = path.join(args.reportDir, args.runId);
  await mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function entriesWithContent(manifest: KnowledgeMarkdownManifest, candidates: readonly MarkdownCandidate[]): Array<MarkdownManifestEntry & { readonly content: string }> {
  const contentByPath = new Map(candidates.map((candidate) => [candidate.path, candidate.content]));
  return manifest.entries.map((entry) => ({
    ...entry,
    content: contentByPath.get(entry.path) ?? "",
  }));
}

async function insertKnowledgeRows(rows: KnowledgeMarkdownRows): Promise<void> {
  const pgConfig = loadMemoryXXPostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  const schema = quoteIdent("knowledge_v1");
  try {
    await client.query("BEGIN");
    for (const document of rows.documents) {
      await client.query(
        `INSERT INTO ${schema}.documents (id, collection, repo, source_root, source_path, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           collection = EXCLUDED.collection,
           repo = EXCLUDED.repo,
           source_root = EXCLUDED.source_root,
           source_path = EXCLUDED.source_path,
           metadata = EXCLUDED.metadata,
           updated_at = now()`,
        [document.id, document.collection, document.repo, document.source_root, document.source_path, JSON.stringify(document.metadata)],
      );
    }
    for (const chunk of rows.chunks) {
      await client.query(
        `INSERT INTO ${schema}.chunks (
           id, document_id, collection, repo, source_path, chunk_index, start_line, end_line,
           content, metadata, embedding_model, embedding_dimension, qdrant_point_id, content_hash, embedding_hash, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, now())
         ON CONFLICT (id) DO UPDATE SET
           document_id = EXCLUDED.document_id,
           collection = EXCLUDED.collection,
           repo = EXCLUDED.repo,
           source_path = EXCLUDED.source_path,
           chunk_index = EXCLUDED.chunk_index,
           start_line = EXCLUDED.start_line,
           end_line = EXCLUDED.end_line,
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding_model = EXCLUDED.embedding_model,
           embedding_dimension = EXCLUDED.embedding_dimension,
           qdrant_point_id = EXCLUDED.qdrant_point_id,
           content_hash = EXCLUDED.content_hash,
           embedding_hash = COALESCE(EXCLUDED.embedding_hash, ${schema}.chunks.embedding_hash),
           updated_at = now()`,
        [
          chunk.id,
          chunk.document_id,
          chunk.collection,
          chunk.repo,
          chunk.source_path,
          chunk.chunk_index,
          chunk.start_line,
          chunk.end_line,
          chunk.content,
          JSON.stringify(chunk.metadata),
          chunk.embedding_model,
          chunk.embedding_dimension,
          chunk.qdrant_point_id,
          chunk.content_hash,
          chunk.metadata.embedding_hash ?? null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function qdrantCollection(): string {
  return process.env.MEMORY_XX_KNOWLEDGE_QDRANT_COLLECTION?.trim() || "knowledge-v1";
}

function qdrantBaseUrl(): string | null {
  const value = process.env.MEMORY_XX_QDRANT_BASE_URL?.trim();
  return value ? value.replace(/\/+$/u, "") : null;
}

function qdrantHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(process.env.MEMORY_XX_QDRANT_API_KEY?.trim() ? { "api-key": process.env.MEMORY_XX_QDRANT_API_KEY.trim() } : {}),
  };
}

async function ensureQdrantCollection(baseUrl: string, collection: string): Promise<void> {
  const get = await fetch(`${baseUrl}/collections/${encodeURIComponent(collection)}`, {
    headers: qdrantHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (get.ok) return;
  const create = await fetch(`${baseUrl}/collections/${encodeURIComponent(collection)}`, {
    method: "PUT",
    headers: qdrantHeaders(),
    body: JSON.stringify({ vectors: { size: 4096, distance: "Cosine" }, on_disk_payload: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!create.ok) throw new Error(`qdrant_collection_create_failed:${create.status}:${await create.text()}`);
}

async function upsertKnowledgeQdrant(rows: KnowledgeMarkdownRows): Promise<IngestResult["qdrant"]> {
  const baseUrl = qdrantBaseUrl();
  const collection = qdrantCollection();
  if (!baseUrl) {
    return { requested: true, ok: false, collection, points_upserted: 0, degraded_reason: "MEMORY_XX_QDRANT_BASE_URL_not_configured" };
  }
  const provider = new OpenAICompatibleEmbeddingProvider();
  const points: unknown[] = [];
  const batchSize = 32;
  try {
    await ensureQdrantCollection(baseUrl, collection);
    for (const chunk of rows.chunks) {
      const embedded = await provider.embed_query({ query: chunk.content.slice(0, 4000), query_terms: [] });
      if (!embedded.embedding || embedded.embedding.length !== chunk.embedding_dimension) {
        return {
          requested: true,
          ok: false,
          collection,
          points_upserted: points.length,
          degraded_reason: embedded.audit.final_error ?? `embedding_dimension_${embedded.embedding?.length ?? 0}`,
        };
      }
      const embeddingHash = hashEmbedding(embedded.embedding);
      points.push({
        id: chunk.qdrant_point_id,
        vector: embedded.embedding,
        payload: {
          chunk_id: chunk.id,
          document_id: chunk.document_id,
          collection: chunk.collection,
          repo: chunk.repo,
          source_path: chunk.source_path,
          chunk_index: chunk.chunk_index,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          content: chunk.content,
          content_hash: chunk.content_hash,
          embedding_hash: embeddingHash,
          metadata: { ...chunk.metadata, embedding_hash: embeddingHash },
        },
      });
      if (points.length >= batchSize) {
        await flushQdrantPoints(baseUrl, collection, points.splice(0, points.length));
      }
    }
    if (points.length > 0) await flushQdrantPoints(baseUrl, collection, points);
    return { requested: true, ok: true, collection, points_upserted: rows.chunks.length };
  } catch (error) {
    return {
      requested: true,
      ok: false,
      collection,
      points_upserted: 0,
      degraded_reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function flushQdrantPoints(baseUrl: string, collection: string, points: readonly unknown[]): Promise<void> {
  if (points.length === 0) return;
  const response = await fetch(`${baseUrl}/collections/${encodeURIComponent(collection)}/points?wait=true`, {
    method: "PUT",
    headers: qdrantHeaders(),
    body: JSON.stringify({ points }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`qdrant_upsert_failed:${response.status}:${await response.text()}`);
}

async function ingestRows(rows: KnowledgeMarkdownRows, args: ParsedArgs): Promise<IngestResult> {
  if (!args.apply) {
    return {
      documents: rows.documents.length,
      chunks: rows.chunks.length,
      postgres_written: false,
      qdrant: { requested: args.withQdrant, ok: !args.withQdrant, collection: qdrantCollection(), points_upserted: 0, degraded_reason: args.withQdrant ? "dry_run" : undefined },
    };
  }
  await insertKnowledgeRows(rows);
  const qdrant = args.withQdrant
    ? await upsertKnowledgeQdrant(rows)
    : { requested: false, ok: true, collection: qdrantCollection(), points_upserted: 0 } satisfies IngestResult["qdrant"];
  return {
    documents: rows.documents.length,
    chunks: rows.chunks.length,
    postgres_written: true,
    qdrant,
  };
}

function archiveManifestForCli(manifest: KnowledgeMarkdownManifest, includeImportCurrent: boolean): KnowledgeMarkdownManifest {
  if (includeImportCurrent) return manifest;
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => entry.lifecycle === "import_current"
      ? { ...entry, should_archive: false }
      : entry),
    summary: {
      ...manifest.summary,
      should_archive: manifest.entries.filter((entry) => entry.lifecycle === "archive_obsolete_no_import" || entry.lifecycle === "archive_duplicate_no_import").length,
    },
  };
}

async function buildRun(args: ParsedArgs): Promise<{
  readonly currentState: StateProbeResult;
  readonly candidates: readonly MarkdownCandidate[];
  readonly manifest: KnowledgeMarkdownManifest;
}> {
  const candidates = await scanMarkdownFiles({ root: args.root, maxFiles: args.maxFiles, maxBytes: args.maxBytes });
  const currentState = await loadCurrentState(args);
  const classifications = classifyMarkdownDocuments(candidates, currentState);
  const manifest = buildKnowledgeMarkdownManifest({
    runId: args.runId,
    generatedAt: currentState.now,
    archiveRoot: args.archiveRoot,
    classifications,
  });
  return { currentState, candidates, manifest };
}

async function main(): Promise<void> {
  const args = parseArgs();
  let output: Record<string, unknown>;

  if (args.command === "scan") {
    const candidates = await scanMarkdownFiles({ root: args.root, maxFiles: args.maxFiles, maxBytes: args.maxBytes });
    output = {
      ok: true,
      command: args.command,
      dry_run: true,
      root: args.root,
      count: candidates.length,
      candidates: candidates.map(stripContent),
    };
  } else {
    const run = await buildRun(args);
    const manifestPath = args.writeReport ? await writeManifestReport(args, run.manifest) : null;
    output = {
      ok: true,
      command: args.command,
      dry_run: args.dryRun,
      apply: args.apply,
      root: args.root,
      run_id: args.runId,
      current_state: run.currentState,
      manifest_path: manifestPath,
      manifest: run.manifest,
    };

    if (args.command === "ingest") {
      const rows = buildKnowledgeMarkdownRows({
        entries: entriesWithContent(run.manifest, run.candidates),
        ingestRunId: args.runId,
      });
      const ingest = await ingestRows(rows, args);
      output = {
        ...output,
        ok: ingest.qdrant.ok || !ingest.qdrant.requested,
        ingest,
      };
    }

    if (args.command === "archive") {
      const archiveManifest = archiveManifestForCli(run.manifest, args.includeImportCurrent);
      const archive = await executeMarkdownArchivePlan({ manifest: archiveManifest, apply: args.apply });
      output = {
        ...output,
        manifest: archiveManifest,
        archive,
        archive_policy: {
          include_import_current: args.includeImportCurrent,
          note: args.includeImportCurrent
            ? "import_current entries are eligible for archive; use only after successful ingest."
            : "import_current entries are not moved unless --include-import-current is set.",
        },
      };
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`memory knowledge md: command=${args.command} ok=${output.ok} dry_run=${output.dry_run ?? true}\n`);
    const manifest = jsonObject(output.manifest);
    if (manifest) process.stdout.write(`summary=${JSON.stringify(manifest.summary)}\n`);
    if (output.manifest_path) process.stdout.write(`manifest=${String(output.manifest_path)}\n`);
  }
  process.exitCode = output.ok === false ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
