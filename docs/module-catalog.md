# memory-xx Module Catalog

This catalog is the public map for hot-pluggable runtime modules and CLI-only full-stack capabilities. PostgreSQL, Redis, Qdrant, wrapper, embedding proxy, and projector form Core. Enhanced and full modules are opt-in and should degrade without breaking Core write/recall.

## Base Operational Commands

These commands are part of the public operating surface. They are not optional
full-stack capabilities; they start Core, inspect state, manage review/agent
operations, or run worker entrypoints directly.

| Area | Public npm entrypoints |
| --- | --- |
| Core startup and migration | `migrate`, `start`, `start:worker`, `run:qdrant-projector-worker` |
| Runtime profile control | `memory:mode`, `memory:up`, `memory:down`, `memory:status` |
| Review and agent operations | `memory:agent`, `memory:review`, `memory:approve`, `memory:reject`, `memory:archive` |
| Operator views | `memory:control-panel`, `memory:dashboard`, `memory:report`, `memory:source-mode` |
| Worker entrypoints | `run:cache-invalidation-worker`, `run:write-ticket-worker`, `run:conversation-monitor-worker`, `run:markdown-projection-worker`, `run:dream-worker` |
| Development smoke upstreams | `memory:dev-embedding-upstream` |
| Import and bridge utilities | `conversation:codex-bridge`, `import:staging` |

## Runtime Modules

| Name | Kind | Profile role | Env switch | Service/source | Degraded behavior |
| --- | --- | --- | --- | --- | --- |
| `wrapper` | core | required: core/enhanced/full | - | `memory-xx-wrapper.service` | HTTP/MCP memory API is unavailable. |
| `postgres` | external | required: core/enhanced/full | - | - | Writes, review state, and recall ledger access fail. |
| `redis` | external | required: core/enhanced/full | - | - | Cache and coordination are bypassed; throughput and latency degrade. |
| `qdrant` | external | required: core/enhanced/full | - | - | Vector recall and current projection are unavailable. |
| `embedding_proxy` | sidecar | required: core/enhanced/full | `MEMORY_XX_EMBEDDING_PROXY_ENABLED` | `memory-xx-embedding-proxy.service` | New query/write vectors fall back to cached/old results or non-vector paths. |
| `embedding_upstream` | external | optional | `MEMORY_XX_EMBEDDING_UPSTREAM_ENABLED` | `memory-xx-embedding-upstream.service` | Local upstream manager is disabled; embedding proxy should use the configured remote or local OpenAI-compatible provider. |
| `projector` | worker | required: core/enhanced/full | - | `memory-xx-qdrant-projector-worker.service` | Committed writes wait in outbox and Qdrant freshness lags. |
| `qdrant_proxy` | sidecar | expected: enhanced/full | `MEMORY_XX_QDRANT_PROXY_ENABLED` | `memory-xx-qdrant-proxy.service` | Collection blue/green routing is disabled; wrapper talks directly to Qdrant. |
| `fastpath` | sidecar | required: full; expected: enhanced | `MEMORY_XX_FASTPATH_ENABLED` | `memory-xx-fastpath.service` | Recall falls back to the Node wrapper path with higher latency. |
| `lexical_sidecar` | sidecar | required: full; expected: enhanced | `MEMORY_XX_LEXICAL_SIDECAR_ENABLED` | `memory-xx-lexical-sidecar.service` | Exact keyword and hybrid recall quality degrade; vector/PostgreSQL fallback remains available. |
| `reranker_upstream` | external | required: full; expected: enhanced | `MEMORY_XX_RERANKER_UPSTREAM_ENABLED` | `memory-xx-reranker-upstream.service` | Reranker adapter is online but cannot call a model. |
| `reranker_adapter` | sidecar | required: full; expected: enhanced | `MEMORY_XX_RERANKER_ADAPTER_ENABLED` | `memory-xx-reranker-adapter.service` | Model reranking is skipped and local rank fusion is used. |
| `llm_upstream` | external | required: full; expected: enhanced | `MEMORY_XX_LLM_UPSTREAM_ENABLED` | - | Mem0 extraction and LLM-backed intelligence use built-in heuristics or remain disabled. |
| `mem0_extractor` | sidecar | required: full; expected: enhanced | `MEMORY_XX_MEM0_EXTRACTOR_ENABLED` | `memory-xx-mem0-extractor.service` | Smart extraction falls back to built-in heuristics or manual write paths. |
| `conversation_monitor` | worker | required: full; expected: enhanced | `MEMORY_XX_CONVERSATION_MONITOR_ENABLED` | `memory-xx-conversation-monitor-worker.service` | Session ingestion is disabled; direct HTTP/MCP memory operations continue. |
| `markdown_projection` | worker | expected: full | `MEMORY_XX_MARKDOWN_PROJECTION_ENABLED` | `memory-xx-markdown-projection.service` | PostgreSQL remains the source of truth; Markdown review projections are not refreshed. |
| `memory_dreaming` | worker | expected: full | `MEMORY_XX_DREAMING_ENABLED` | `memory-xx-dream-worker.service` | Background dreaming/promoted insight generation is disabled; explicit write/recall continues. |
| `control_panel` | control | required: full; expected: enhanced | `MEMORY_XX_CONTROL_PANEL_ENABLED` | `memory-xx-control-panel.service` | CLI and API operations continue; web operations console is unavailable. |
| `cache_invalidation_worker` | worker | expected: full | `MEMORY_XX_CACHE_INVALIDATION_WORKER_ENABLED` | `memory-xx-cache-invalidation-worker.service` | Durable cache invalidation requests are not drained automatically; direct write/recall continues and operators can run the worker manually. |
| `write_ticket_worker` | worker | expected: full | `MEMORY_XX_WRITE_TICKET_WORKER_ENABLED` | `memory-xx-write-ticket-worker.service` | Asynchronous fast_ack write tickets are not processed automatically; synchronous write paths continue. |
| `maintenance_orchestrator` | worker | expected: full | `MEMORY_XX_MAINTENANCE_ENABLED` | `memory-xx-maintenance.service` | Scheduled maintenance is disabled; manual repair, sweep, and governance commands remain available. |
| `temporal_consolidation` | worker | expected: full | `MEMORY_XX_CONSOLIDATION_ENABLED` | `memory-xx-consolidation.service` | Temporal consolidation and archive recommendations are not run automatically. |
| `runtime_issue_detection` | gate | expected: full | `MEMORY_XX_RUNTIME_ISSUE_DETECTION_ENABLED` | `memory-xx-detect.service` | Automatic runtime issue detection is disabled; manual Doctor and repair checks remain available. |
| `auto_repair` | worker | expected: full | `MEMORY_XX_AUTO_REPAIR_ENABLED` | `memory-xx-auto-repair.service` | Automatic repair is disabled; Qdrant and embedding repair must be run manually. |
| `repair_report` | gate | expected: full | `MEMORY_XX_REPAIR_REPORT_ENABLED` | `memory-xx-repair-report.service` | Daily repair reporting is disabled; operators must inspect Doctor and repair output manually. |
| `landing_scan` | gate | expected: full | `MEMORY_XX_LANDING_SCAN_ENABLED` | `memory-xx-landing-scan.service` | Production landing evidence is not refreshed automatically. |
| `canary_7d_report` | gate | expected: full | `MEMORY_XX_CANARY_7D_REPORT_ENABLED` | `memory-xx-canary-7d-report.service` | 7-day canary evidence is not refreshed automatically. |
| `quality_runner` | gate | required: full | `MEMORY_XX_QUALITY_RUNNER_ENABLED` | `memory-xx-quality-runner.service` | Recall quality has not completed release validation. |
| `governance_report` | gate | required: full | `MEMORY_XX_GOVERNANCE_REPORT_ENABLED` | `memory-xx-governance-report.service` | Governance backlog has not completed release validation. |

## Full-Stack Capabilities

| Name | Profile | Maturity | Env switch | Dependencies | Degraded behavior |
| --- | --- | --- | --- | --- | --- |
| `knowledge_ingest` | enhanced | beta | `MEMORY_XX_KNOWLEDGE_INGEST_ENABLED` | - | Long-form documents are not ingested automatically; short memory write/recall continues. |
| `memory_knowledge_graph` | enhanced | beta | `MEMORY_XX_MEMORY_GRAPH_ENABLED` | - | Graph evidence and graph recall boosts are skipped; vector and lexical recall remain available. |
| `code_graph` | enhanced | beta | `MEMORY_XX_CODE_GRAPH_ENABLED` | - | Repository symbol/import/call graph views are unavailable; memory graph and recall continue. |
| `temporal_decay` | full | beta | `MEMORY_XX_TEMPORAL_DECAY_ENABLED` | - | Temporal decay scoring and archive candidate generation are not run automatically. |
| `temporal_consolidation` | full | beta | `MEMORY_XX_CONSOLIDATION_ENABLED` | - | Duplicate/episode consolidation suggestions are not produced automatically. |
| `memory_dreaming` | full | experimental | `MEMORY_XX_DREAMING_ENABLED` | - | Background dreaming/promoted insight generation is disabled; explicit write/recall continues. |
| `policy_evaluation` | full | beta | `MEMORY_XX_POLICY_EVAL_ENABLED` | - | Policy evaluation reports are not refreshed automatically; runtime policy still executes. |
| `recall_quality` | full | beta | `MEMORY_XX_RECALL_QUALITY_ENABLED` | `fastpath`, `lexical_sidecar`, `reranker_adapter` | Release quality evidence is not refreshed automatically; recall still uses configured runtime paths. |
| `auto_approval_ops` | full | beta | `MEMORY_XX_AUTO_APPROVAL_ENABLED` | - | Pending memories remain reviewable manually; automatic approvals and sweeps do not run. |
| `auto_update_ops` | full | beta | `MEMORY_XX_AUTO_UPDATE_ENABLED` | - | Supersede/update candidates are not applied automatically; normal write and manual review continue. |
| `embedding_manifest` | enhanced | stable | `MEMORY_XX_EMBEDDING_MANIFEST_ENABLED` | - | Embedding generation validation is skipped; wrapper still uses the configured provider and Qdrant collection. |
| `embedding_calibration` | full | beta | `MEMORY_XX_EMBEDDING_CALIBRATION_ENABLED` | `embedding_proxy` | Embedding timeout/concurrency recommendations are not refreshed automatically. |
| `local_embedding_generation` | full | beta | `MEMORY_XX_LOCAL_EMBEDDING_GENERATION_ENABLED` | `embedding_proxy`, `qdrant` | Bulk local vector regeneration is disabled; online writes still use the configured embedding provider. |
| `backup_and_restore` | full | beta | `MEMORY_XX_BACKUP_ENABLED` | - | Automated backup planning is unavailable; database-native backups can still be run externally. |
| `platform_doctor` | enhanced | stable | `MEMORY_XX_PLATFORM_DOCTOR_ENABLED` | - | Automated environment diagnosis is unavailable; health endpoints and explicit checks still work. |
| `trusted_agent_tools` | enhanced | stable | `MEMORY_XX_TRUSTED_AGENT_TOOLS_ENABLED` | - | Token and scope grant provisioning must be handled manually; strict scope enforcement remains available. |
| `qdrant_reconciliation` | full | beta | `MEMORY_XX_QDRANT_RECONCILE_ENABLED` | `qdrant`, `projector`, `qdrant_proxy` | Projection repair is not run automatically; vector freshness may lag while Postgres remains authoritative. |
| `conversation_ops` | enhanced | beta | `MEMORY_XX_CONVERSATION_OPS_ENABLED` | `conversation_monitor` | Conversation source diagnostics and monitor reports are unavailable; direct memory APIs continue. |
| `governance_operations` | full | beta | `MEMORY_XX_GOVERNANCE_OPS_ENABLED` | - | Governance audits, cleanup, freeze/revert, and pending reports are not refreshed automatically; manual review APIs remain available. |
| `runtime_observability_retention` | full | beta | `MEMORY_XX_RUNTIME_OBSERVABILITY_RETENTION_ENABLED` | - | Runtime traces and observability artifacts are not compacted automatically; online memory operations continue. |
| `write_ticket_maintenance` | full | beta | `MEMORY_XX_WRITE_TICKET_MAINTENANCE_ENABLED` | - | Expired write tickets are not swept or archived automatically; new writes still use the normal idempotency path. |
| `deployment_packaging` | full | beta | `MEMORY_XX_DEPLOYMENT_PACKAGING_ENABLED` | - | Deployment bundle, migration preflight, and memory-specific secrets audit must be run manually or by external tooling. |
| `release_governance_gates` | full | beta | `MEMORY_XX_RELEASE_GOVERNANCE_GATES_ENABLED` | `landing_scan`, `canary_7d_report`, `recall_quality` | Release gates, landing/canary evidence, and capacity checks are not refreshed automatically; Core operations continue. |
| `self_improvement_ops` | full | experimental | `MEMORY_XX_SELF_IMPROVEMENT_ENABLED` | - | Report-only self-improvement proposals and Graphiti shadow export are disabled; normal governance and review continue. |

## Full-Stack Capability Commands

These npm scripts are the public entrypoints for CLI-only capability packages.
Capability env switches default to `0`; use these commands only after the
matching dependencies are configured.

| Capability | Public npm entrypoints |
| --- | --- |
| `knowledge_ingest` | `memory:knowledge-md`, `smoke:knowledge-graph` |
| `memory_knowledge_graph` | `memory:graph-report`, `memory:graph-health`, `smoke:knowledge-graph` |
| `code_graph` | `memory:code-graph` |
| `temporal_decay` | `memory:decay`, `memory:temporal-sweep`, `memory:temporal-policy`, `smoke:temporal-ops` |
| `temporal_consolidation` | `memory:consolidate`, `smoke:temporal-ops` |
| `memory_dreaming` | `run:dream-worker`, `smoke:memory-dreaming` |
| `policy_evaluation` | `memory:policy-corpus`, `memory:policy-eval`, `memory:policy-report`, `memory:debt-plan`, `smoke:policy-ops` |
| `recall_quality` | `memory:quality`, `memory:intelligence-quality`, `memory:reranker-policy-benchmark`, `memory:p1-evidence`, `memory:recall-repair`, `memory:trace-feedback`, `smoke:recall-quality` |
| `auto_approval_ops` | `memory:auto-approval`, `memory:auto-approval-ops`, `memory:auto-approval-sweep`, `memory:auto-approval-limit-advisor` |
| `auto_update_ops` | `memory:auto-update` |
| `embedding_manifest` | `memory:embedding-manifest`, `smoke:embedding-ops` |
| `embedding_calibration` | `memory:embedding-calibrate`, `smoke:embedding-ops` |
| `local_embedding_generation` | `memory:generate-local-embeddings`, `generate:embeddings`, `memory:local-qwen8b-benchmark`, `smoke:local-embedding-generation` |
| `backup_and_restore` | `memory:backup`, `smoke:backup-ops` |
| `platform_doctor` | `memory:platform-doctor`, `memory:doctor`, `smoke:runtime-profiles`, `smoke:compose-core`, `smoke:compose-profile-live`, `smoke:cache-invalidation`, `smoke:markdown-projection` |
| `trusted_agent_tools` | `memory:trusted-agent`, `smoke:trusted-agent` |
| `qdrant_reconciliation` | `memory:qdrant-reconcile`, `memory:fix-qdrant-replay`, `replay:qdrant-outbox`, `memory:outbox-recovery`, `memory:qdrant-alias`, `memory:qdrant-collection-audit`, `smoke:qdrant-reconciliation` |
| `conversation_ops` | `memory:conversation-sources`, `memory:conversation-monitor-report`, `smoke:conversation-monitor` |
| `governance_operations` | `memory:governance-audit`, `memory:governance-cleanup`, `memory:governance-freeze`, `memory:governance-revert`, `memory:policy-backfill`, `memory:pending-canary-report`, `memory:pending-governance`, `memory:pending`, `memory:governance`, `memory:governance-dry-run-jobs`, `memory:governance-stuck-runs`, `memory:memory-type-backfill`, `memory:event-lifecycle`, `memory:archive-events`, `smoke:governance-ops` |
| `runtime_observability_retention` | `memory:runtime-observability-retention`, `memory:trace-retention`, `memory:cleanup-runtime-artifacts`, `memory:archive-next-residue`, `smoke:runtime-observability` |
| `write_ticket_maintenance` | `memory:sweep-write-ticket-timeouts`, `memory:archive-write-tickets`, `memory:sweep-ingest-accepted`, `memory:sweep-low-confidence`, `smoke:write-ticket` |
| `deployment_packaging` | `memory:migration-preflight`, `memory:deployment-bundle`, `memory:secrets-audit`, `smoke:backup-ops` |
| `release_governance_gates` | `memory:p0-gate`, `memory:p1-gate`, `memory:cutover-gate`, `memory:landing-scan`, `memory:canary-7d-report`, `memory:freeze-m0`, `memory:capacity-audit`, `memory:capacity-smoke`, `memory:consistency-scan`, `memory:dlq-recovery`, `memory:quality-metadata-backfill`, `shadow:recall`, `shadow:projection`, `verify:open-source-full-stack`, `smoke:full-ops` |
| `self_improvement_ops` | `memory:self-improvement`, `memory:graphiti-shadow-export`, `memory:sweep-test-pollution`, `smoke:self-improvement-ops` |
