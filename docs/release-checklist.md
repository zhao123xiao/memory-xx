# memory-xx Open-Source Release Checklist

Use this checklist before tagging a public release. It is intentionally
maintainer-facing: normal users should follow the quickstart, while release
maintainers must prove that Core, enhanced, and full-stack modules remain
reproducible and degradable.

## Required Gates

Run these commands from a clean checkout of GitHub `main`:

```bash
TMPDIR=/tmp npm ci
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run verify:open-source
TMPDIR=/tmp npm run open-source:completion-audit
TMPDIR=/tmp npm run open-source:provider-matrix
TMPDIR=/tmp npm run check:migrations
TMPDIR=/tmp npm run check:hardcoded-paths
TMPDIR=/tmp npm run audit:prod
```

Run the full-stack release gate before publishing:

```bash
TMPDIR=/tmp npm run verify:open-source-full-stack
```

Before tagging, update `CHANGELOG.md` with the public release scope, release
evidence, provider matrix status, and any known limitations.

`open-source:completion-audit` is the objective-level audit. It checks the
runtime module registry, full-stack capability manifest, source/script
entrypoints, public docs, stale naming, and optional reference parity when
`MEMORY_XX_PARITY_REFERENCE_ROOT` is set.

`open-source:provider-matrix` records provider-neutral release evidence for
OpenAI-compatible embedding, OpenAI-compatible LLM, OpenAI-compatible reranker,
Qdrant, and Redis. Set `MEMORY_XX_PROVIDER_MATRIX_LIVE=1` in a maintainer
environment to require live provider probes before tagging.

For non-Docker CI environments, the same gate may skip Compose while still
checking typecheck, tests, public readiness, migration order, hardcoded paths,
and stale public compatibility names:

```bash
MEMORY_XX_RELEASE_GATE_SKIP_COMPOSE=1 TMPDIR=/tmp npm run verify:open-source-full-stack
```

When comparing against the private/reference implementation, provide the
reference tree explicitly:

```bash
MEMORY_XX_PARITY_REFERENCE_ROOT=/path/to/reference-tree \
  TMPDIR=/tmp npm run open-source:parity-audit -- \
  --reference-root "$MEMORY_XX_PARITY_REFERENCE_ROOT" --json
```

Set `MEMORY_XX_RELEASE_GATE_REQUIRE_PARITY=1` only in maintainer environments
where `MEMORY_XX_PARITY_REFERENCE_ROOT` is available.

## Compose Evidence

The public release must demonstrate all three runtime profiles:

```bash
TMPDIR=/tmp npm run smoke:compose-core-live
TMPDIR=/tmp npm run smoke:compose-enhanced
TMPDIR=/tmp npm run smoke:compose-full
```

Expected evidence:

| Profile | Required evidence |
| --- | --- |
| `core` | wrapper, PostgreSQL, Redis, Qdrant, embedding proxy, and Qdrant projector start; M1 write/project/recall succeeds. |
| `enhanced` | Core stays healthy while fastpath, lexical sidecar, Qdrant proxy, reranker adapter, Mem0 extractor, conversation monitor, control panel, and dev upstreams can be enabled. |
| `full` | Enhanced services plus full operations modules are present; M1 write/recall still succeeds; report-only gates may report blockers without breaking Core. |

## Provider matrix

The repository must stay provider-neutral. The release does not require one
vendor, but it must preserve these OpenAI-compatible surfaces:

| Provider surface | Public config | Required release check |
| --- | --- | --- |
| OpenAI-compatible embedding | `EMBEDDING_API_BASE`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS`, `OPENAI_API_KEY` | Core starts through `memory-xx-embedding-proxy`; dev embedding upstream remains available for local smoke. |
| OpenAI-compatible LLM | `MEMORY_INTELLIGENCE_BASE_URL`, `MEMORY_XX_LLM_UPSTREAM_HEALTH_URL` | Mem0 extractor can be enabled, and native extraction remains available when the LLM upstream is disabled. |
| OpenAI-compatible reranker | `MEMORY_XX_RERANKER_DOWNSTREAM_URL`, `MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL` | Reranker adapter can be enabled, and recall falls back to local fusion when reranker is disabled. |
| Qdrant | `MEMORY_XX_QDRANT_BASE_URL`, `MEMORY_XX_QDRANT_COLLECTION` | Projector and reconciliation smokes keep PostgreSQL authoritative when projection is stale or unavailable. |
| Redis | `MEMORY_XX_REDIS_URL`, `MEMORY_XX_REDIS_PREFIX` | Cache and coordination can be bypassed or degraded without preventing direct write/recall. |

Do not publish provider-specific defaults, local model paths, or private host
URLs in public docs or config templates.

## Hot-Pluggable Degradation

Before release, verify hot-pluggable degradation from both code and docs:

- `core` must not require fastpath, lexical, reranker, Mem0, conversation
  monitor, control panel, or full operations modules.
- Every runtime module in `app/runtime-modules.ts` must have an env switch or
  explicit required Core role, a health/service/source reference when relevant,
  and degraded behavior.
- Every CLI-only full-stack capability in `app/full-stack-capabilities.ts` must
  have an env switch, source/script paths, dependencies, and degraded behavior.
- Disabled optional modules must not block Core write/recall.
- Enabled modules with missing dependencies must report `missing_dependency` or
  degraded health instead of appearing healthy.

Useful checks:

```bash
TMPDIR=/tmp npm run smoke:runtime-profiles
TMPDIR=/tmp npm run memory:mode -- plan --mode core
TMPDIR=/tmp npm run memory:mode -- plan --mode enhanced
TMPDIR=/tmp npm run memory:mode -- plan --mode full
TMPDIR=/tmp npm run smoke:compose-profile-live
```

## No-go Conditions

Do not tag a public release when any of these are true:

- Public docs, config, code, or workflow files contain historical environment
  prefixes, old API paths, previous project names, or compatibility wording.
- `README.md`, `.env.example`, `configs/*`, `docker-compose.yml`, or `systemd/*`
  omit `MEMORY_XX_*` / `/api/memory/xx` naming.
- GitHub CI does not run `verify:open-source` and
  `verify:open-source-full-stack`.
- `verify:open-source-full-stack` fails without a documented environmental
  reason.
- Core write/recall depends on an enhanced/full-only module.
- Enhanced/full sidecars are documented as mandatory for normal Core users.
- Provider-specific endpoints, private paths, secrets, or local model artifacts
  are committed.
- A full-stack capability exists in the reference implementation but is missing
  from `app/full-stack-capabilities.ts`, `docs/module-catalog.md`, or public
  npm entrypoints.
