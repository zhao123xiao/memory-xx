#!/usr/bin/env node
import http from "node:http";
import { URL } from "node:url";
import pg from "pg";

const { Pool } = pg;

const DEFAULT_LIMIT = readPositiveInt("MEMORY_XX_LEXICAL_DEFAULT_LIMIT", 50);
const MAX_LIMIT = readPositiveInt("MEMORY_XX_LEXICAL_MAX_LIMIT", 100);
const DATABASE_URL = readEnv("MEMORY_XX_DATABASE_URL") || readEnv("DATABASE_URL");
const SCHEMA = readEnv("MEMORY_XX_DATABASE_SCHEMA") || "public";

let pool;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: readPositiveInt("MEMORY_XX_LEXICAL_PG_POOL_MAX", 4),
    idleTimeoutMillis: readPositiveInt("MEMORY_XX_LEXICAL_PG_IDLE_TIMEOUT_MS", 10000),
    connectionTimeoutMillis: readPositiveInt("MEMORY_XX_LEXICAL_PG_CONNECT_TIMEOUT_MS", 1500),
  });
}

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value || "";
}

function readPositiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAddress() {
  const raw = readEnv("MEMORY_XX_LEXICAL_ADDR") || `127.0.0.1:${readPositiveInt("MEMORY_XX_LEXICAL_PORT", 5210)}`;
  const normalized = raw.startsWith(":") ? `0.0.0.0${raw}` : raw;
  const [host, portText] = normalized.includes(":")
    ? normalized.split(":")
    : [normalized, String(readPositiveInt("MEMORY_XX_LEXICAL_PORT", 5210))];
  return {
    host: host || "127.0.0.1",
    port: Number.parseInt(portText, 10) || 5210,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

function scopeFromBody(body) {
  const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
  const type = typeof body.scopeType === "string" ? body.scopeType : scope.type;
  const id = typeof body.scopeId === "string" ? body.scopeId : scope.id;
  if (!type || !id) return null;
  return { type, id };
}

async function databaseAvailable() {
  if (!pool) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function buildSearchTerms(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 16);
}

function candidateFromRow(row, queryTerms) {
  const searchable = String(row.searchable_text ?? "").toLowerCase();
  const matched = queryTerms.filter((term) => searchable.includes(term));
  const lexicalScore = Number(row.lexical_score ?? 0);
  return {
    memory_id: row.id,
    title: row.title ?? undefined,
    content: row.content,
    summary: row.summary ?? undefined,
    score: lexicalScore,
    scope: { type: row.scope_type, id: row.scope_id },
    memory_type: row.memory_type ?? undefined,
    lifecycle_status: row.lifecycle_status,
    review_state: row.review_state,
    is_current: row.is_current,
    source: "lexical_sidecar",
    matched_terms: matched,
    payload: {
      memory_id: row.id,
      lexical_score: lexicalScore,
      source_retrievers: ["lexical"],
      source_path: row.source_uri ?? undefined,
      source_type: row.source_type ?? undefined,
      lifecycle_status: row.lifecycle_status,
      review_state: row.review_state,
      is_current: row.is_current,
    },
  };
}

async function runSearch(body) {
  const query = String(body.query ?? "").trim();
  const scope = scopeFromBody(body);
  const limit = normalizeLimit(body.limit ?? body.topK);
  if (!query) {
    return { ok: true, candidates: [], degraded: false, reason: "empty_query" };
  }
  if (!scope) {
    return { ok: true, candidates: [], degraded: true, reason: "missing_scope" };
  }
  if (!pool) {
    return { ok: true, candidates: [], degraded: true, reason: "postgres_not_configured" };
  }

  const terms = buildSearchTerms(query);
  const likePatterns = terms.length > 0 ? terms.map((term) => `%${term}%`) : [`%${query.toLowerCase()}%`];

  try {
    const result = await pool.query(
      `
        WITH candidate_records AS (
          SELECT
            mr.id,
            mr.scope_type,
            mr.scope_id,
            mr.title,
            mr.summary,
            mr.content,
            mr.metadata,
            mr.lifecycle_status,
            mr.review_state,
            mr.is_current,
            ms.source_type,
            ms.uri AS source_uri,
            lower(concat_ws(' ',
              COALESCE(mr.title, ''),
              COALESCE(mr.summary, ''),
              COALESCE(mr.content, ''),
              COALESCE(ms.uri, ''),
              COALESCE(ms.excerpt, ''),
              COALESCE(ms.source_type, ''),
              COALESCE((SELECT string_agg(tag.value, ' ')
                FROM jsonb_array_elements_text(COALESCE(mr.metadata -> 'tags', '[]'::jsonb)) AS tag(value)), ''),
              COALESCE((SELECT string_agg(entity.value, ' ')
                FROM jsonb_array_elements_text(COALESCE(mr.metadata -> 'entity_names', '[]'::jsonb)) AS entity(value)), ''),
              COALESCE((SELECT string_agg(term.value, ' ')
                FROM jsonb_array_elements_text(COALESCE(mr.metadata -> 'lexical_terms', '[]'::jsonb)) AS term(value)), '')
            )) AS searchable_text
          FROM ${quoteIdent(SCHEMA)}.memory_records mr
          LEFT JOIN LATERAL (
            SELECT source_type, uri, excerpt
            FROM ${quoteIdent(SCHEMA)}.memory_sources
            WHERE memory_id = mr.id
            ORDER BY confidence DESC NULLS LAST, created_at ASC
            LIMIT 1
          ) ms ON TRUE
          WHERE mr.scope_type = $1
            AND mr.scope_id = $2
            AND mr.lifecycle_status = 'approved'
            AND mr.review_state IN ('approved', 'not_required')
            AND mr.is_current = TRUE
        )
        SELECT *,
          (
            SELECT count(*)::float8
            FROM unnest($3::text[]) pattern
            WHERE searchable_text LIKE pattern
          ) / GREATEST(cardinality($3::text[]), 1) AS lexical_score
        FROM candidate_records
        WHERE searchable_text LIKE ANY($3::text[])
        ORDER BY lexical_score DESC, id ASC
        LIMIT $4
      `,
      [scope.type, scope.id, likePatterns, limit]
    );
    return {
      ok: true,
      candidates: result.rows.map((row) => candidateFromRow(row, terms)),
      degraded: false,
    };
  } catch (error) {
    return {
      ok: true,
      candidates: [],
      degraded: true,
      reason: error instanceof Error ? `postgres_search_failed:${error.message}` : "postgres_search_failed",
    };
  }
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    const available = await databaseAvailable();
    writeJson(res, 200, {
      ok: true,
      service: "memory-xx-lexical-sidecar",
      status: available ? "ok" : "degraded",
      postgres: available ? "ok" : pool ? "unavailable" : "not_configured",
    });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/search" || url.pathname === "/recall")) {
    try {
      writeJson(res, 200, await runSearch(await readJson(req)));
    } catch (error) {
      writeJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "invalid_request",
      });
    }
    return;
  }

  writeJson(res, 404, { ok: false, error: "not_found" });
}

const { host, port } = parseAddress();
const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "internal_error" });
  });
});

server.listen(port, host, () => {
  console.log(`memory-xx lexical sidecar listening on ${host}:${port}`);
});

async function shutdown() {
  server.close();
  if (pool) await pool.end();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
