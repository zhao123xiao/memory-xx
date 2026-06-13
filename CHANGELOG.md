# Changelog

## 0.1.0 - 2026-06-05 - memory-xx public preview

This public preview turns the running private memory system into the open-source
`memory-xx` repository. The release target is a reproducible Core stack plus
enhanced and full-stack modules that can be enabled, disabled, or degraded
without breaking Core write/recall.

### Release scope

- Core: wrapper, PostgreSQL, Redis, Qdrant, embedding proxy, and Qdrant
  projector for write/project/recall.
- Enhanced: optional fastpath, lexical sidecar, Qdrant proxy, reranker adapter,
  Mem0 extractor, conversation monitor, control panel, and provider dev
  upstreams.
- Full-stack: pluggable operations capabilities for knowledge ingest, graph
  reports, temporal governance, memory dreaming, policy evaluation, recall
  quality, auto-approval/update ops, embedding ops, backup/restore, trusted
  agent tooling, Qdrant reconciliation, governance, observability retention,
  write-ticket maintenance, deployment packaging, release gates, and
  self-improvement reports.

### Release evidence

- `verify:open-source` checks public docs, config, source entrypoints, runtime
  modules, full-stack capabilities, provider-neutral defaults, and production
  dependency audit.
- `verify:open-source-full-stack` is the maintainer release gate for Core,
  enhanced, and full-stack reproducibility.
- `open-source:completion-audit` checks hot-pluggable runtime coverage,
  full-stack capability coverage, stale naming, release docs, provider matrix,
  and optional parity against the private reference tree.
- `open-source:provider-matrix` records provider-neutral evidence for
  OpenAI-compatible embedding, OpenAI-compatible LLM, OpenAI-compatible
  reranker, Qdrant, and Redis. Set `MEMORY_XX_PROVIDER_MATRIX_LIVE=1` to require
  live provider probes before tagging.

### Compatibility boundary

- Public configuration uses `MEMORY_XX_*`.
- Public HTTP API paths use `/api/memory/xx`.
- OpenClaw remains an optional adapter, not a required Core dependency.
- Provider-specific endpoints, private local paths, secrets, runtime data, and
  model artifacts are not part of the public release.
