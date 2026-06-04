# Operations Guide — Memory XX

## Runtime Chain And Boundaries

The default online chain is:

```text
memory-xx Postgres -> Qdrant active alias -> wrapper/optional fastpath -> agent adapters
```

- Postgres schema `memory_xx` is the source of truth.
- Qdrant alias `memory-xx-active` is the approved/current vector projection.
- The wrapper on port `5100` is the stable HTTP API; fastpath, lexical, graph,
  and reranker services improve quality or latency but do not replace the
  ledger.
- `<linux-user-home>/memory` and `<linux-user-home>/data/memory/memory.db` are
  retired legacy assets, not audit mirrors for the current runtime. Do not
  treat legacy SQLite pending/stale embedding counts as current runtime
  blockers unless a separate task restores the old chain.
- Optional agent adapters, including OpenClaw, should call memory-xx tools
  (`memory_xx_recall`, `memory_xx_write`, and orchestrator routes) with scoped
  trusted-agent tokens. Keep the admin token for manual operations and CLI
  checks only.
- Agent-specific legacy memory status commands are not memory-xx health checks.
  Verify memory-xx through `/health`, scoped recall/write smoke, projector
  health, and Qdrant alias checks.
- On WSL, run npm/tsx commands and systemd services with `TMPDIR=/tmp` to avoid
  tsx Unix socket creation under Windows temp paths.

## Health Check

```bash
curl http://localhost:5100/health
TMPDIR=/tmp npm run memory:status
```

- `status: "ok"` — all subsystems healthy
- `status: "degraded"` — one or more subsystems unavailable (check `vector.available`, `redis`)

Key fields:
- `runtime_initialised` — Postgres + runtime loaded
- `runtime_profile` — `core`, `enhanced`, or `full`; defaults to `core`
- `dependency_profile` — required/expected/optional components for the active
  runtime profile
- `runtime_modules.states` — canonical hot-plug state for every module:
  `enabled`, `disabled`, `degraded`, or `missing_dependency`; the control panel
  uses the same registry.
- `vector.available` — Qdrant or pgvector reachable
- `config.openai_api_key_configured` — embedding API key set
- `query_embedding_cache.stats.redis_hit_rate` — Redis query embedding cache effectiveness
- `embedding_generation.ok` — active Postgres manifest, Qdrant alias target,
  Redis prefix, query cache version, and sampled payload generation all match
- embedding proxy health is exposed separately at `http://127.0.0.1:5221/health`
  with `recent_429_15m`, `cache_hit_rate`, `upstream_latency_ms`, `queue_wait_ms`,
  and `cooldown_until`
- `strict_scope` in `memory:doctor` — strict is the default; set
  `MEMORY_XX_SCOPE_POLICY_MODE=single_user` only as rollback

## Local Agent Registration

Every local agent must use its own trusted-agent token. Do not share the admin
token with normal agents.

```bash
TMPDIR=/tmp npm run memory:agent -- create <agent-id> --project=<project-id>
TMPDIR=/tmp npm run memory:agent -- create <agent-id> --role=governance --project=<project-id>
TMPDIR=/tmp npm run memory:agent -- create codex-main --project=memory-xx --env-file=<linux-user-home>/.codex/memory-xx.env
TMPDIR=/tmp npm run memory:agent -- audit
```

Default scope policy:

- `project:<project-id>`: read/write/feedback when supplied.
- `workspace:current-instance`: read/write/feedback.
- `user:<agent-id>`: agent-private read/write/feedback.
- `user:local`: read-only by default.
- `global:global`: read-only by default.

Use `--allow-user-write` or `--allow-global-write` only for agents that are
allowed to mutate owner/global memory. Use `--env-file=<path>` when the token
should be saved directly into a private runtime env file; the command writes it
with `0600` permissions.

For MCP stdio or `/mcp` clients, set `MEMORY_XX_MCP_TOKEN` to the trusted-agent
token. The MCP server prefers `MEMORY_XX_MCP_TOKEN` over `MEMORY_XX_API_TOKEN`.
The agent still needs matching `trusted_agent_scope_grants` rows for every
project, workspace, user, or global scope it accesses.

## Knowledge And Code Graphs

The control panel exposes both the existing memory knowledge graph and a local
repository code graph. The code graph follows the lightweight code-intelligence
shape used by code graph systems: files, symbols, imports, declarations, and
call references are explicit nodes/edges, while memory knowledge graph data
continues to come from `memory_entities`, `memory_entity_links`, and
`memory_relations`.

```bash
TMPDIR=/tmp npm run memory:control-panel
TMPDIR=/tmp npm run memory:code-graph -- --root=<project-root>
TMPDIR=/tmp npm run memory:code-graph -- --root=<project-root> --query=GraphRetriever --json
```

The control panel graph viewport is 3D. Use the graph selector to switch between
`知识图谱` and `Code Graph`.

## Runtime Profiles

Daily operation should use the vector-capable Core profile. Release validation
and the current full local stack should set `MEMORY_XX_RUNTIME_PROFILE=full`
explicitly; Doctor treats missing or contradictory profile settings as a
configuration blocker.

```bash
MEMORY_XX_RUNTIME_PROFILE=core
TMPDIR=/tmp npm run memory:mode -- status
TMPDIR=/tmp npm run memory:doctor -- --target ops-ready --mode core --plan
```

Profiles:

| Profile | Use | Required behavior |
|---|---|---|
| `core` | Daily stable mode | wrapper, Postgres, Redis, Qdrant, embedding proxy, projector |
| `enhanced` | Better recall quality/latency | Core plus expected fastpath, lexical sidecar, reranker, graph recall |
| `full` | Release/governance/quality validation | Enhanced plus one-shot quality, graph, embedding manifest, governance gates |

Startup helpers:

```bash
TMPDIR=/tmp npm run memory:mode -- plan --mode core
TMPDIR=/tmp npm run memory:up -- --mode core
TMPDIR=/tmp npm run memory:up -- --mode enhanced
TMPDIR=/tmp npm run memory:mode -- plan --mode full
TMPDIR=/tmp npm run smoke:compose-profile-live
```

`smoke:compose-profile-live` should be run after a Compose profile is up. It
compares `docker compose ps --all` with the wrapper `/health` runtime module
snapshot, so enabled enhanced/full modules must have a matching running
container while disabled module containers may exit cleanly.

Public harness layers can be run individually when validating a module. `L1`
checks the unit and HTTP contract layer, while `L19` exercises the conversation
monitor path from JSONL spool ingestion through recall. The cache invalidation,
write ticket, markdown projection, memory dreaming, full ops, and policy ops smokes validate durable
background workers against live PostgreSQL, Redis, Qdrant, the configured
embedding provider, generated projection files, safe degraded dream cycles, and
full-profile maintenance/governance/quality reportability. `smoke:policy-ops`
uses policy evaluation, auto-approval reporting, and auto-update dry-run paths;
it does not apply approvals or updates:

```bash
TMPDIR=/tmp npm run test:unit-contract
TMPDIR=/tmp npm run test:conversation-monitor
TMPDIR=/tmp npm run smoke:cache-invalidation
TMPDIR=/tmp npm run smoke:write-ticket
TMPDIR=/tmp npm run smoke:markdown-projection
TMPDIR=/tmp npm run smoke:memory-dreaming
TMPDIR=/tmp npm run smoke:full-ops
TMPDIR=/tmp npm run smoke:policy-ops
```

`L7` validates the optional OpenClaw adapter. It is non-blocking by default in
the public harness so deployments without OpenClaw can still validate Core,
enhanced, and full memory-xx modules. Require it only for environments where
that optional adapter is part of the target deployment:

```bash
TMPDIR=/tmp node --import tsx scripts/test-harness/reports/aggregator.ts --layer=L7 --require-openclaw
MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION=1 TMPDIR=/tmp node --import tsx scripts/test-harness/reports/aggregator.ts --layer=L7
```

`memory:mode` probes Postgres, Redis, Qdrant, and local/Windows embedding
dependencies but does not start those external processes. Current public
systemd service names use stable `memory-xx-*.service` units.

`systemd/memory-xx.target` starts only the Core online chain by default:
wrapper, Qdrant projector worker, and embedding proxy. Start enhanced/full
modules with `memory:up -- --mode enhanced`, `memory:up -- --mode full`,
`memory-xx-enhanced.target`, `memory-xx-full.target`, or explicit individual
systemd units after their model/API dependencies are ready.

## P1/P2 Production Closure

P1 promotes PostgreSQL `memory_xx` to the only Source of Truth. Manual audit and
fact review now use Postgres records/events, graph reports, recall traces,
Qdrant reconcile, and L3/L4 quality reports. Markdown/SQLite legacy assets are
not maintained as a secondary audit view.

The full P1 gate gathers P0, cutover evidence, maintenance, graph health,
decay/temporal health, intelligence quality, DLQ recovery, and runtime config
validation. It writes evidence under `reports/memory-xx-p1/`; cutover gate
evidence is written under `reports/memory-xx-cutover/`.

```bash
TMPDIR=/tmp npm run memory:p1-gate -- --mode full
TMPDIR=/tmp npm run memory:p1-evidence -- --apply
TMPDIR=/tmp npm run memory:cutover-gate -- --stage m4 --json
TMPDIR=/tmp npm run memory:cutover-gate -- --stage m5 --json
```

`memory:p1-evidence` samples approved/current recall, validates default filter
visibility, checks cache invalidation health, writes
`reports/memory-xx-cutover/m4-local-agent-gate-metrics.json`, and tops up local
intelligence compare observations to the minimum P1 sample size.

Unified maintenance runs in a fixed order: lease, P0 preflight,
outbox/DLQ recovery, temporal sweep, decay/archive, consolidation, graph
consistency, Doctor audit/repair/stats, then quality snapshot. `report` mode is
dry-run where possible. `auto` may soft-archive expired/low-strength memories or
replay retriable recovery events, and records run evidence under
`reports/memory-xx-maintenance/`; final step failures are also appended to
`.runtime/maintenance-step-dlq.jsonl`.

```bash
TMPDIR=/tmp npm run memory:maintenance -- run --mode report --json
TMPDIR=/tmp npm run memory:maintenance -- run --mode auto --json
```

Graph and Intelligence both degrade safely before they can damage recall/write
quality. Graph health writes `.runtime/graph-health-latest.json`, and recall
caps graph fusion weight when coverage, consistency, latency, or L18 quality
signals are weak. Intelligence quality writes
`.runtime/intelligence-candidate-only.json` when FP proxies or negative probes
fail, causing smart-write to stop silent approval and produce candidates only.

```bash
TMPDIR=/tmp npm run memory:graph-health -- --json
TMPDIR=/tmp npm run memory:intelligence-quality -- --json
TMPDIR=/tmp npm run memory:decay -- run --mode report --json
TMPDIR=/tmp npm run memory:temporal-sweep -- --json
TMPDIR=/tmp npm run memory:dlq-recovery -- scan --json
```

Runtime config is validated through the shared TS validator used by L0, Doctor,
P0/P1 gates, and `/health`. Critical config issues block startup/gates; warnings
stay visible in health and reports without failing the wrapper solely by
themselves.

## Visual Control Panel

Start the local browser control panel:

```bash
TMPDIR=/tmp npm run memory:control-panel
```

It listens on `http://127.0.0.1:5310/` by default and exposes only allowlisted
commands such as runtime profile status, Doctor targets, Core/Enhanced service
start/stop helpers, and lightweight gates. The API requires a per-process panel
token embedded in the served page and does not expose arbitrary shell execution.

On the Windows desktop, use `打开 memory-xx 控制面板.cmd` to start the WSL panel
server and open the browser.

## Embedding Rate Limit Calibration

The embedding model may be cloud-hosted or served locally through Windows
OpenVINO Model Server. Cloud mode must be treated as a constrained dependency.
Use the small-batch calibration gate before increasing cloud throughput:

```bash
TMPDIR=/tmp npm run memory:embedding-calibrate
```

The report is written under `reports/memory-xx-tests/embedding-calibration/`
and recommends `EMBEDDING_PROXY_MAX_CONCURRENCY`,
`EMBEDDING_PROXY_MIN_INTERVAL_MS`, timeout, retry, and cooldown values. The
default production stance is stability-first: keep interaction timeouts short,
use cache/stale fallback, and avoid retry storms on 429/503.

For an optional local OpenAI-compatible embedding upstream, point the proxy at
the upstream base URL and model exposed by your local server:

```bash
MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_BASE=http://127.0.0.1:<port>/v1
MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_MODEL=<local-embedding-model-name>
MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_API_KEY_FILE=<path-to-api-key-file>
MEMORY_XX_EMBEDDING_PROXY_MAX_CONCURRENCY=1
MEMORY_XX_EMBEDDING_PROXY_MIN_INTERVAL_MS=0
```

Local upstream managers are optional. Keep them disabled when the proxy points
at a remote OpenAI-compatible provider.

## Embedding Generation Switch

Production Qdrant access should use the stable alias `memory-xx-active`.
The active manifest in Postgres must match the alias target, Redis prefix,
query cache version, and Qdrant payload `embedding_generation`.

```bash
TMPDIR=/tmp npm run memory:embedding-manifest -- status
TMPDIR=/tmp npm run memory:embedding-manifest -- validate --generation-id=memory-xx-default-v1
TMPDIR=/tmp npm run memory:embedding-manifest -- activate --generation-id=memory-xx-default-v1
TMPDIR=/tmp npm run memory:embedding-manifest -- rollback
```

Use the consistency scan before release or after suspected projector lag. By
default it is report-only: it reports PG approved/current records missing from
Qdrant, orphan Qdrant points, payload generation mismatch, and outbox status
counts.

```bash
TMPDIR=/tmp npm run memory:consistency-scan -- --json
```

If the only issue is PG approved/current records missing from Qdrant, use the
explicit repair mode. It re-syncs by `memory_id`, can generate a missing local
embedding through the configured provider, and does not mutate outbox/cursor
state.

```bash
TMPDIR=/tmp npm run memory:consistency-scan -- --json --repair-missing --limit 10
```

After activation or rollback, restart wrapper and projector, then run:

```bash
TMPDIR=/tmp npm run memory:doctor -- --target embedding-ready --plan
TMPDIR=/tmp npm run test:quality
TMPDIR=/tmp npm run check:observation
```

## Metrics

```bash
curl -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" http://localhost:5100/metrics
curl -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" http://localhost:5100/metrics/prometheus
```

Returns JSON with:
- `http_requests_total` — cumulative request count by method/route/status
- `http_request_duration_ms` — { count, sum, avg, min, max } for request latency
- `memory_recall_latency_ms`, `memory_write_latency_ms`, and
  `memory_embedding_latency_ms` — Prometheus histograms for release/ops tracking
- `memory_qdrant_*timeout*` and `memory_post_commit_degraded_*` — runtime
  degradation counters/gauges surfaced from health snapshots

`/metrics` remains authenticated. Use a dedicated read-only token for Prometheus
or the local control panel; do not expose anonymous metrics on a shared network.
Reset in-memory metrics by restarting the service.

## Safety Defaults

HTTP CORS defaults to local desktop origins only (`localhost` / `127.0.0.1`).
Set `MEMORY_XX_CORS_ORIGINS` explicitly for any non-local control-plane
consumer; the wrapper does not fall back to wildcard origins.

Qdrant projection readback is bounded by
`MEMORY_XX_QDRANT_VERIFY_TIMEOUT_MS` (default 1200ms) and
`MEMORY_XX_QDRANT_VERIFY_RETRIES` (default 2). Verify failures mark only the
affected projected memories and rely on outbox replay plus consistency scan for
repair.

Single-wrapper deployments use the local semantic write lock. Before running
multiple wrappers, set `MEMORY_XX_SEMANTIC_LOCK_BACKEND=redis`, verify Redis is
healthy, and rerun `release-ready`; Doctor blocks multi-instance local locks.

Decay and consolidation defaults are configurable without code changes:
`MEMORY_XX_DECAY_ARCHIVE_THRESHOLD=0.30`,
`MEMORY_XX_DECAY_HIDE_THRESHOLD=0.10`, and
`MEMORY_XX_EPISODE_WINDOW_HOURS=24`.

## Event Lifecycle

`memory_events` and `outbox_events` are append-only ledgers. Routine operation
does not physically delete them. Use the report-only lifecycle scanner before
release and when Doctor reports pending/dead-letter growth:

```bash
TMPDIR=/tmp npm run memory:event-lifecycle -- --json
TMPDIR=/tmp npm run memory:archive-events -- --json
TMPDIR=/tmp npm run memory:archive-events -- --apply --json
```

Defaults: successful `outbox_events` are archive-eligible after 90 days,
`memory_events` after 180 days, and pending/failed/dead-letter outbox rows are
never automatically archived. `--apply` writes an archive artifact only; it does
not physically delete production rows.

## Alerts

Set `MEMORY_XX_ALERT_WEBHOOK_URL` to enable webhook notifications for Doctor
blockers and capacity/degradation checks. If unset, alerts stay visible in
Doctor and the control panel only. Embedding/OVMS down, Qdrant down, projector
dead-letter, post-commit degradation, recent 429/503, and release gate failures
should be treated as operational alerts.

## Log Search

All logs are JSON lines to stdout/stderr. Filter with `jq`:

```bash
# Errors only
cat /tmp/memory-xx-wrapper.log | jq 'select(.level=="ERROR")'

# Specific trace ID
cat /tmp/memory-xx-wrapper.log | jq 'select(.traceId=="abc-123")'

# Slow requests (>1s)
cat /tmp/memory-xx-wrapper.log | jq 'select(.duration_ms > 1000)'
```

Log level controlled by `MEMORY_XX_LOG_LEVEL` (error/warn/info/debug).

## Degradation Behavior

| Component Down | Behavior |
|---|---|
| Qdrant unavailable | Falls back to pgvector if configured; recall still works (lexical search) |
| Qdrant projection lag | Newly committed writes may be briefly absent from vector recall until outbox/projector catches up; run `memory:consistency-scan` for report-only diagnosis |
| Redis unavailable | Cache bypassed; every recall hits Postgres directly |
| OpenAI API down | New memories saved without embeddings; vector search degraded for those records |
| Postgres down | `/health` returns 503; all write/recall operations fail |
| Reranker unavailable | Local rerank remains; recall quality may drop |
| Fastpath unavailable | Wrapper/node recall fallback remains; latency may increase |
| Embedding 429 | Query embedding cache/stale fallback is used when possible; vector recall degrades otherwise |

## Historical `*-next` Residue

Current public service names no longer use the experimental `*-next` suffix.
Old `wrapper-next.*`, `qdrant-projector-worker-next.*`, and sidecar `*-next.*`
logs can still be archived without deletion:

```bash
TMPDIR=/tmp npm run memory:archive-next-residue
```

## Strict Scope Rollback

Strict scope is the default when `MEMORY_XX_SCOPE_POLICY_MODE` is unset. Legacy
tokens are denied for scoped write/feedback/review/knowledge/MCP operations.
Use this only for emergency compatibility rollback:

```bash
printf '\nMEMORY_XX_SCOPE_POLICY_MODE=single_user\n' >> <project-root>/.env
systemctl --user restart memory-xx-wrapper.service
```

## Restart

```bash
# Local (WSL)
pkill -f memory-xx
nohup npm run start > /tmp/memory-xx-wrapper.log 2>&1 &

# Remote
pkill -f memory-xx
cd /home/ubuntu/services/memory-xx
set -a; . ./.env; set +a
nohup npm run start > /tmp/memory-xx-wrapper.log 2>&1 &
```

## Repository Boundary

The git root is `<linux-user-home>`, but memory-xx work must be scoped to
`<project-root>`. Before committing, use:

```bash
git status --short -- <project-root>
git diff --stat -- <project-root>
```

## Docker

```bash
docker-compose up --build -d
docker-compose logs -f memory-xx
docker-compose down
```

The default Compose command starts the Core path: wrapper, embedding proxy,
Qdrant projector worker, Postgres, Redis, and Qdrant. Optional modules are
exposed through profiles:

```bash
MEMORY_XX_RUNTIME_PROFILE=enhanced docker-compose --profile enhanced up --build -d
MEMORY_XX_RUNTIME_PROFILE=full docker-compose --profile full up --build -d
```

`enhanced` starts fastpath, lexical sidecar, Qdrant proxy, reranker adapter, and
the local control panel. `full` includes the enhanced services and also starts
Mem0 extraction, the conversation monitor, cache invalidation worker, and the operations/gate modules for
maintenance, consolidation, issue detection, auto-repair, repair reporting,
landing scan, and 7-day canary reporting. Those full modules still honor their
own `MEMORY_XX_*_ENABLED=0` switches and exit without work until enabled.
Model upstreams remain environment-specific; configure
`EMBEDDING_PROXY_UPSTREAM_BASE`, `OPENAI_API_KEY`, reranker downstream URLs, and
Mem0/LLM settings before relying on those modules.
