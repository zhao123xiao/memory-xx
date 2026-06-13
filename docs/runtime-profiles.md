# memory-xx Runtime Profiles

`MEMORY_XX_RUNTIME_PROFILE` controls operational expectations. It does not
remove capabilities from the code path; it tells Doctor and operators which
components are required, expected, or optional for the current goal.

## Profiles

| Profile | Purpose | Required |
|---|---|---|
| `core` | Daily stable operation | wrapper, Postgres, Redis, Qdrant, embedding proxy, projector |
| `enhanced` | Better recall latency/quality | Core required; fastpath, lexical sidecar, reranker, graph recall are expected |
| `full` | Release, quality, governance, embedding switch validation | Enhanced services plus quality, graph, embedding manifest, and governance gates |

`core` is intentionally vector-capable. It is not a lexical-only emergency mode.
If fastpath, lexical sidecar, reranker, or graph enhancement is unavailable,
Core recall/write should still work and should report optional degradation.

## Commands

```bash
TMPDIR=/tmp npm run memory:mode -- status
TMPDIR=/tmp npm run memory:mode -- plan --mode core
TMPDIR=/tmp npm run memory:up -- --mode core
TMPDIR=/tmp npm run memory:up -- --mode enhanced
TMPDIR=/tmp npm run memory:mode -- plan --mode full
TMPDIR=/tmp npm run memory:doctor -- --target ops-ready --mode core --plan
```

`memory:mode` only manages known systemd user services. It probes Postgres,
Redis, Qdrant, and Windows/local OVMS embedding dependencies, but does not start
or stop those external dependencies.

## Service Policy

Existing service names are preserved, including historical `*-next` names such
as `memory-xx-embedding-proxy-next.service`. Runtime profiles classify those
services; they do not rename them.

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
