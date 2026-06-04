# memory-xx Runtime Profiles

`MEMORY_XX_RUNTIME_PROFILE` controls operational expectations. It does not
remove capabilities from the code path; it tells Doctor and operators which
components are required, expected, or optional for the current goal.

## Profiles

| Profile | Purpose | Required |
|---|---|---|
| `core` | Daily stable operation | wrapper, Postgres, Redis, Qdrant, embedding proxy, projector |
| `enhanced` | Better recall latency/quality | Core required; fastpath, lexical sidecar, Qdrant proxy, reranker, Mem0 extractor, conversation monitor, and control panel are expected but degradable |
| `full` | Release, quality, governance, embedding switch validation | Enhanced services become release requirements, plus maintenance, consolidation, auto-repair, landing/canary, quality, and governance gates |

`core` is intentionally vector-capable. It is not a lexical-only emergency mode.
If fastpath, lexical sidecar, reranker, or graph enhancement is unavailable,
Core recall/write should still work and should report optional degradation.

The public repository includes source entries for embedding proxy, Qdrant proxy,
reranker adapter, Mem0 extractor, fastpath, and lexical recall under
`sidecars/`. Fastpath and lexical recall ship Node.js implementations of the
HTTP sidecar contracts; optimized Go/Rust implementations can replace them in a
deployment as long as the contracts stay compatible. They can be disabled with
`MEMORY_XX_FASTPATH_ENABLED=0` and `MEMORY_XX_LEXICAL_SIDECAR_ENABLED=0`.
Mem0 extraction depends on an external OpenAI-compatible LLM endpoint, modeled
as `llm_upstream` in `/health`; set `MEMORY_XX_MEM0_BASE_URL` or
`MEMORY_INTELLIGENCE_BASE_URL` for that dependency.
Markdown projection is modeled as `markdown_projection`: PostgreSQL remains the
source of truth, while generated Markdown files are read-only review/export
views. Enable it with `MEMORY_XX_MARKDOWN_PROJECTION_ENABLED=1` and set
`MEMORY_XX_PROJECTION_ROOT_DIR` when you want projections outside the default
`memory_projection/` directory. The module can be run with
`TMPDIR=/tmp npm run run:markdown-projection-worker`, the
`memory-xx-markdown-projection.service` systemd unit, or the
`memory-xx-markdown-projection` Docker Compose full-profile service.

Operations modules are modeled separately from sidecars. `maintenance_orchestrator`,
`cache_invalidation_worker`, `write_ticket_worker`, `temporal_consolidation`, `runtime_issue_detection`, `auto_repair`,
`repair_report`, `landing_scan`, and `canary_7d_report` are full-profile
modules with their own env switches and systemd units. They are disabled by
default and can be enabled per environment without affecting Core write/recall.

Non-service full-stack capabilities are tracked in `app/full-stack-capabilities.ts`.
This manifest covers feature packages such as Knowledge ingest, Memory/Code
Graph, Temporal decay/consolidation, Memory dreaming, Policy evaluation, and
Recall quality. It also tracks production operations packages such as
auto-approval/update operations, embedding generation manifest and calibration,
local embedding generation, backup, platform doctor, trusted agent tooling, and
Qdrant reconciliation. It also classifies production CLI-only operations such as
conversation source diagnostics, governance audit/cleanup/freeze/revert,
runtime observability retention, write-ticket sweeps, migration preflight,
deployment bundle generation, memory-specific secrets audit, release governance
gates, and report-only self-improvement operations. The open-source release gate
checks that their source files and CLI scripts are exported even when the
capability is disabled by default. `/health` exposes the same manifest as
`full_stack_capabilities.states`, including each capability's profile, maturity,
env switch, exported source/script paths, dependencies, state, reason, and
degraded behavior. Capability states use `enabled`, `disabled`, or
`missing_dependency`: `enabled` records operator intent, while
`missing_dependency` means the switch is on but a required runtime module or
capability is unavailable. A disabled or missing-dependency capability should
not block Core unless a service module in `runtime_modules.states` is also
required by the selected runtime profile.
The public `configs/memory-xx-wrapper.env.example` lists every
`full_stack_capabilities.states[*].env_enabled` switch with a default `0` value
so operators can opt into each package explicitly.

Memory dreaming is exposed as the experimental `memory_dreaming` capability.
Enable it with `MEMORY_XX_DREAMING_ENABLED=1`, then run
`TMPDIR=/tmp npm run run:dream-worker -- --once` for a single cycle or start
`memory-xx-dream-worker.service` / the `memory-xx-dream-worker` Compose
full-profile service. It calls wrapper health, audit, and optional repair tasks;
when disabled, Core write/recall is unaffected.

## Wrapper Activation Switches

Runtime module switches start or classify sidecars and external dependencies.
They do not always make the wrapper route traffic to that module. Configure the
wrapper-side activation switch after the sidecar is healthy:

```bash
# Fastpath recall sidecar: start the sidecar, then make it the primary recall path.
MEMORY_XX_FASTPATH_ENABLED=1
MEMORY_XX_RECALL_PRIMARY=fastpath

# Model reranker: start the adapter/upstream, then let recall call the adapter.
MEMORY_XX_RERANKER_ADAPTER_ENABLED=1
MEMORY_XX_RERANKER_MODE=model
MEMORY_XX_RERANKER_ENDPOINT=http://127.0.0.1:8085/rerank

# Mem0-style extraction: start the extractor/LLM upstream, then select it.
MEMORY_XX_MEM0_EXTRACTOR_ENABLED=1
MEMORY_INTELLIGENCE_PROVIDER=mem0
MEMORY_INTELLIGENCE_MEM0_URL=http://127.0.0.1:5220
```

Leaving these wrapper-side switches unset keeps Core behavior: Node recall path,
local rerank fusion, and native intelligence extraction. That is the expected
degraded behavior when an enhanced/full module is unavailable in a local
environment.

## Runtime Module States

`app/runtime-modules.ts` is the canonical module registry. Each module records:

- profile role: required, expected, or optional
- env switch, for example `MEMORY_XX_RERANKER_ADAPTER_ENABLED`
- health URL or systemd unit when applicable
- health URL env key and fallback keys for injected runtime environments
- whether an enabled external upstream must have a configured health URL
- repo source path when source is included
- degraded behavior when the module is disabled or unhealthy

The public `configs/memory-xx-wrapper.env.example` also lists every
`runtime_modules.states[*].env_enabled` switch. Core modules default to enabled;
enhanced/full sidecars, workers, and gates default to disabled until their
dependencies are configured.

`/health` exposes the same registry as `runtime_modules.states`, and the control
panel converts those states into component rows. Doctor should use the same
semantics: `enabled`, `disabled`, `degraded`, or `missing_dependency`. A disabled
optional/enhanced module should not block `core`; a missing required module
should block the selected profile.

## Commands

```bash
TMPDIR=/tmp npm run memory:mode -- status
TMPDIR=/tmp npm run smoke:runtime-profiles
TMPDIR=/tmp npm run smoke:runtime-profiles -- --live --url http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/health
TMPDIR=/tmp npm run memory:mode -- plan --mode core
TMPDIR=/tmp npm run memory:up -- --mode core
TMPDIR=/tmp npm run memory:up -- --mode enhanced
TMPDIR=/tmp npm run memory:mode -- plan --mode full
TMPDIR=/tmp npm run memory:doctor -- --target ops-ready --mode core --plan
TMPDIR=/tmp npm run memory:source-mode
TMPDIR=/tmp npm run memory:source-mode -- --verify --limit 500
```

`memory:mode` only manages known systemd user services. It probes Postgres,
Redis, Qdrant, and configured embedding dependencies, but does not start or
stop external providers. The local `memory-xx-embedding-upstream.service`
manager is optional and disabled by default; enable it only when this deployment
uses the bundled local OVMS/OpenAI-compatible upstream instead of a remote
embedding provider.

## Service Policy

Current public service names use stable `memory-xx-*.service` units. Historical
`*-next` names are treated only as migration residue; runtime profiles classify
the stable units and do not require legacy aliases.

`systemd/memory-xx.target` is intentionally Core-only. It starts wrapper,
projector, and embedding proxy so a default user install does not accidentally
pull environment-specific enhanced/full modules such as reranker, Mem0,
conversation monitor, or the control panel.

Use `TMPDIR=/tmp npm run memory:up -- --mode enhanced` or start individual
`systemd/` units to opt into enhanced modules. Use `--mode full` only when the
local model/API dependencies and operations modules for the full stack are
configured.

Core services are never stopped by `memory:down`. `memory:down -- --mode
enhanced` stops only enhanced/full optional services such as fastpath, lexical
sidecar, and reranker.

## Doctor Semantics

- `ops-ready --mode core`: blocks on Core required components only.
- `ops-ready --mode enhanced`: reports enhanced services as expected; Core
  requirements still determine hard readiness.
- `release-ready --mode full`: uses strict release semantics, including quality,
  graph, embedding generation, and routing validation.
- `strict-ready` and `embedding-ready`: check their own safety/consistency
  boundaries and do not fail merely because fastpath or reranker is absent.
