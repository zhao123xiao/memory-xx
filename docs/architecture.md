# memory-xx Architecture

## Module Structure

```
app/
  server/       HTTP server, auth middleware, rate limiting, metrics, route handlers
  recall/       Recall orchestrator, vector retrieval, query classification, alias expansion
  write/        Memory creation service, idempotency, dedupeKey conflict resolution
  review/       Lifecycle management -- approve / reject / archive / supersede / tombstone
  cache/        4-layer Redis cache (search, startup_context, session, recent)
  qdrant-sync/  Vector projection sync, embedding resolution
  orchestrator/ High-level operations combining recall + write + review
  shared/       Shared types, logger, error classes, contracts
  db/           Database repositories, migration runner, SQL queries
```

### Module Responsibilities

| Module | Key Concern |
|---|---|
| `server/` | Express HTTP server setup, JWT/API-key auth, IP-based rate limiter, Prometheus-style metrics collection |
| `recall/` | Receives a natural-language query, classifies intent, expands aliases, retrieves candidates from vector store, re-ranks, returns scored results |
| `write/` | Validates incoming `CreateMemoryCommand`, handles idempotent replays via `requestId`, resolves `dedupeKey` conflicts, writes to Postgres in a transaction |
| `review/` | Implements the lifecycle state machine (`candidate -> approved/rejected -> archived/superseded/tombstoned`), validates transitions, updates `is_current` flag |
| `cache/` | Four Redis cache layers: (1) search result cache keyed by query+scope hash, (2) startup context preload, (3) per-session transient cache, (4) recent-writes cache. Cache invalidation is triggered on every write and review action |
| `qdrant-sync/` | Listens for write/review events, resolves embeddings via the configured embedding provider, upserts or deletes vectors in Qdrant to keep the projection in sync with Postgres |
| `orchestrator/` | High-level facade that composes scope resolution, recall, write, review, and consistency operations into single-call endpoints |
| `shared/` | TypeScript interfaces (`CreateMemoryCommand`, `RecallRequest`, `MemoryRecord`, etc.), structured logger, typed error hierarchy |
| `db/` | Repository classes for memories and lifecycle events, SQL query builders, migration runner for schema versioning |

---

## Data Flow

### Write Path

```
HTTP POST /write
  --> server/handler (auth, rate limit, validate)
    --> write/CreateMemoryService
      --> Postgres INSERT (transactional: memory record + lifecycle event)
      --> cache/invalidation (evict affected search & recent caches)
      --> qdrant-sync/projection (resolve embedding, upsert vector)
    --> HTTP 201 response
```

### Recall Path

```
HTTP POST /recall/query
  --> server/handler (auth, rate limit, validate)
    --> recall/RecallOrchestrator
      --> cache/check (return cached results if hit)
      --> embedding/query (embed the search text)
      --> Qdrant or PGVector search (filtered by scope & lifecycle)
      --> ranking (re-score, merge candidates)
    --> cache/store (cache the result set)
    --> HTTP 200 response
```

### Review Path

```
HTTP POST /review/memories/:id/:action
  --> server/handler (auth, rate limit, validate)
    --> review/ReviewService
      --> Postgres UPDATE (lifecycle state machine transition)
      --> cache/invalidation (evict affected caches)
    --> qdrant-sync (if tombstoned, delete vector; if superseded, re-index)
    --> HTTP 200 response
```

---

## Configuration

All configuration is via `MEMORY_XX_*` environment variables. The live local
runtime is wrapper `5100` -> fastpath `5200` -> lexical `5210`, with Redis on
`6381`, Qdrant on `6333`, and PostgreSQL selected by
`MEMORY_XX_DATABASE_URL`. Query/write embeddings go through the local
embedding proxy on `5221`, which rate-limits the cloud provider and exposes
cache/429/latency health.

| Variable | Purpose | Default |
|---|---|---|
| `MEMORY_XX_WRAPPER_PORT` | HTTP listen port | `5100` |
| `MEMORY_XX_RUNTIME_PROFILE` | Operational profile: `core`, `enhanced`, or `full` | `core` |
| `MEMORY_XX_DATABASE_URL` | Postgres truth-ledger connection string | required |
| `MEMORY_XX_DATABASE_SCHEMA` | Postgres schema | `memory_xx` |
| `MEMORY_XX_REDIS_URL` | Redis cache/coordination URL | `redis://127.0.0.1:6381/0` in live local env |
| `MEMORY_XX_REDIS_PREFIX` | Redis key namespace; must match active embedding generation | `memory-xx-local-qwen8b-int4` in live local env |
| `MEMORY_XX_QDRANT_BASE_URL` | Qdrant REST endpoint | `http://127.0.0.1:6333` |
| `MEMORY_XX_QDRANT_COLLECTION` | Qdrant production alias, not a raw generation collection | `memory-xx-active` |
| `MEMORY_XX_QDRANT_ALIAS` | Qdrant alias controlled by `memory:embedding-manifest activate/rollback` | `memory-xx-active` |
| `MEMORY_XX_EMBEDDING_GENERATION_ID` | Active embedding generation manifest id | `local-qwen8b-int4-v1` |
| `MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION` | Query embedding cache namespace; must match active manifest | generation-specific |
| `MEMORY_XX_WRAPPER_MODE` | Wrapper-internal compatibility mode, not the overall runtime profile | `full` in service env |
| `MEMORY_XX_SCOPE_POLICY_MODE` | `strict` by default; set `single_user` only for rollback | `strict` |
| `MEMORY_XX_SEMANTIC_LOCK_BACKEND` | Semantic write lock backend; `local` for one wrapper, `redis` for multi-wrapper readiness | `local` |
| `MEMORY_XX_QDRANT_VERIFY_TIMEOUT_MS` | Qdrant projector readback verification timeout | `1200` |
| `MEMORY_XX_QDRANT_VERIFY_RETRIES` | Qdrant projector readback retry count | `2` |
| `MEMORY_XX_DECAY_ARCHIVE_THRESHOLD` | Decay score below which current memories are archive candidates | `0.30` |
| `MEMORY_XX_DECAY_HIDE_THRESHOLD` | Decay score below which memories are hidden | `0.10` |
| `MEMORY_XX_EPISODE_WINDOW_HOURS` | Consolidation episode grouping time window | `24` |
| `MEMORY_XX_API_TOKEN` | Legacy read/write/feedback token | -- |
| `MEMORY_XX_MCP_TOKEN` | Scoped trusted-agent token preferred by MCP stdio and `/mcp` fallback | trusted-agent token |
| `MEMORY_XX_ADMIN_TOKEN` | Admin/bypass token for operations and strict gates | -- |
| `EMBEDDING_API_BASE` | Embedding API base URL | local proxy in production |
| `EMBEDDING_PROXY_MIN_INTERVAL_MS` | Cloud embedding start spacing | calibration-driven, stability-first |
| `EMBEDDING_PROXY_MAX_CONCURRENCY` | Cloud embedding max in-flight requests | `1` unless calibration proves higher is safe |

### Runtime Profiles

- **`core`** -- default daily mode. Requires wrapper, Postgres, Redis, Qdrant,
  embedding proxy, and projector. Fastpath, lexical sidecar, reranker, and graph
  recall are optional degradations.
- **`enhanced`** -- Core plus expected fastpath, lexical sidecar, reranker, and
  graph recall for better quality/latency.
- **`full`** -- release/governance/quality mode. Uses Enhanced services plus
  one-shot quality, graph benchmark, embedding manifest, and governance gates.
- **rollback-only compatibility** -- set `MEMORY_XX_SCOPE_POLICY_MODE=single_user`
  to temporarily restore legacy scoped access while keeping the same runtime
  profile.

### Vector Backends

- **`qdrant-primary`** -- selected when `MEMORY_XX_QDRANT_BASE_URL` and
  `MEMORY_XX_QDRANT_COLLECTION` are configured. Qdrant is the primary ANN
  projection and pgvector/lexical are fallback paths.
- **`postgres-primary`** -- compatibility mode when Qdrant is not configured.

### Recall Fusion Weights

RRF uses `k=20`. Weights are query-type aware: exact/source/preference style
queries favor lexical (`lexical=1.25`, `vector=0.8`, `graph=0.75`); decision,
timeline, historical, and debug queries favor graph (`graph=1.9`); entity,
project-context, current-state, and episode queries use stronger graph evidence
(`graph=2.1`); exploratory semantic queries slightly favor vector
(`vector=1.1`). The recall audit reports active weights per request.

---

## Dual Deployment

### WSL Local (Development)

| Component | Value |
|---|---|
| HTTP port | `5100` |
| PostgreSQL | localhost, default port 5432 |
| Redis | localhost, port 6381 |
| Qdrant | localhost, default port 6333 |
| Embedding proxy | localhost, port 5221 |

### Remote Server (Production)

| Component | Value |
|---|---|
| HTTP port | `5100` |
| PostgreSQL | configured via `MEMORY_XX_DATABASE_URL` |
| Redis | port `6381` |
| Qdrant | configured via `MEMORY_XX_QDRANT_BASE_URL` |
| Embedding proxy | local sidecar on port `5221`, upstream configured by env |

Both deployments share the same codebase and schema. Differences are handled entirely through environment variables.
