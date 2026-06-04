# memory-xx Module Catalog

This catalog is the public map for hot-pluggable runtime modules and CLI-only full-stack capabilities. PostgreSQL, Redis, Qdrant, wrapper, embedding proxy, and projector form Core. Enhanced and full modules are opt-in and should degrade without breaking Core write/recall.

## Runtime Modules

| Name | Kind | Profile role | Env switch | Service/source | Degraded behavior |
| --- | --- | --- | --- | --- | --- |
| `wrapper` | core | required: core/enhanced/full | - | `memory-xx-wrapper.service` | HTTP/MCP memory API is unavailable. |
| `postgres` | external | required: core/enhanced/full | - | - | Writes, review state, and recall ledger access fail. |
| `redis` | external | required: core/enhanced/full | - | - | Cache and coordination are bypassed; throughput and latency degrade. |
| `qdrant` | external | required: core/enhanced/full | - | - | Vector recall and current projection are unavailable. |
| `embedding_proxy` | sidecar | required: core/enhanced/full | `MEMORY_XX_EMBEDDING_PROXY_ENABLED` | `memory-xx-embedding-proxy-next.service` | New query/write vectors fall back to cached/old results or non-vector paths. |
| `embedding_upstream` | external | expected: core/enhanced/full | `MEMORY_XX_EMBEDDING_UPSTREAM_ENABLED` | `memory-xx-embedding-upstream.service` | Embedding proxy is online but cannot generate new vectors. |
| `projector` | worker | required: core/enhanced/full | - | `memory-xx-qdrant-projector-worker.service` | Committed writes wait in outbox and Qdrant freshness lags. |
| `qdrant_proxy` | sidecar | expected: enhanced/full | `MEMORY_XX_QDRANT_PROXY_ENABLED` | `memory-xx-qdrant-proxy-next.service` | Collection blue/green routing is disabled; wrapper talks directly to Qdrant. |
| `fastpath` | sidecar | required: full; expected: enhanced | `MEMORY_XX_FASTPATH_ENABLED` | `memory-xx-fastpath.service` | Recall falls back to the Node wrapper path with higher latency. |
| `lexical_sidecar` | sidecar | required: full; expected: enhanced | `MEMORY_XX_LEXICAL_SIDECAR_ENABLED` | `memory-xx-lexical-sidecar.service` | Exact keyword and hybrid recall quality degrade; vector/PostgreSQL fallback remains available. |
| `reranker_upstream` | external | required: full; expected: enhanced | `MEMORY_XX_RERANKER_UPSTREAM_ENABLED` | `memory-xx-reranker-upstream.service` | Reranker adapter is online but cannot call a model. |
| `reranker_adapter` | sidecar | required: full; expected: enhanced | `MEMORY_XX_RERANKER_ADAPTER_ENABLED` | `memory-xx-reranker-adapter-next.service` | Model reranking is skipped and local rank fusion is used. |
| `llm_upstream` | external | required: full; expected: enhanced | `MEMORY_XX_LLM_UPSTREAM_ENABLED` | - | Mem0 extraction and LLM-backed intelligence use built-in heuristics or remain disabled. |
| `mem0_extractor` | sidecar | required: full; expected: enhanced | `MEMORY_XX_MEM0_EXTRACTOR_ENABLED` | `memory-xx-mem0-extractor.service` | Smart extraction falls back to built-in heuristics or manual write paths. |
| `conversation_monitor` | worker | required: full; expected: enhanced | `MEMORY_XX_CONVERSATION_MONITOR_ENABLED` | `memory-xx-conversation-monitor-worker.service` | Session ingestion is disabled; direct HTTP/MCP memory operations continue. |
| `markdown_projection` | worker | expected: full | `MEMORY_XX_MARKDOWN_PROJECTION_ENABLED` | `memory-xx-markdown-projection.service` | PostgreSQL remains the source of truth; Markdown review projections are not refreshed. |
| `control_panel` | control | required: full; expected: enhanced | `MEMORY_XX_CONTROL_PANEL_ENABLED` | `memory-xx-control-panel.service` | CLI and API operations continue; web operations console is unavailable. |
| `maintenance_orchestrator` | worker | expected: full | `MEMORY_XX_MAINTENANCE_ENABLED` | `memory-xx-maintenance.service` | Scheduled maintenance is disabled; manual repair, sweep, and governance commands remain available. |
| `temporal_consolidation` | worker | expected: full | `MEMORY_XX_CONSOLIDATION_ENABLED` | `memory-xx-consolidation.service` | Temporal consolidation and archive recommendations are not run automatically. |
| `runtime_issue_detection` | gate | expected: full | `MEMORY_XX_RUNTIME_ISSUE_DETECTION_ENABLED` | `memory-xx-detect.service` | Automatic runtime issue detection is disabled; manual Doctor and repair checks remain available. |
| `auto_repair` | worker | expected: full | `MEMORY_XX_AUTO_REPAIR_ENABLED` | `memory-xx-auto-repair.service` | Automatic repair is disabled; Qdrant and embedding repair must be run manually. |
| `repair_report` | gate | expected: full | `MEMORY_XX_REPAIR_REPORT_ENABLED` | `memory-xx-repair-report.service` | Daily repair reporting is disabled; operators must inspect Doctor and repair output manually. |
| `landing_scan` | gate | expected: full | `MEMORY_XX_LANDING_SCAN_ENABLED` | `memory-xx-landing-scan.service` | Production landing evidence is not refreshed automatically. |
| `canary_7d_report` | gate | expected: full | `MEMORY_XX_CANARY_7D_REPORT_ENABLED` | `memory-xx-canary-7d-report.service` | 7-day canary evidence is not refreshed automatically. |
| `quality_runner` | gate | required: full | - | - | Recall quality has not completed release validation. |
| `governance_report` | gate | required: full | - | - | Governance backlog has not completed release validation. |

## Full-Stack Capabilities

| Name | Profile | Maturity | Env switch | Degraded behavior |
| --- | --- | --- | --- | --- |
| `knowledge_ingest` | enhanced | beta | `MEMORY_XX_KNOWLEDGE_INGEST_ENABLED` | Long-form documents are not ingested automatically; short memory write/recall continues. |
| `memory_knowledge_graph` | enhanced | beta | `MEMORY_XX_MEMORY_GRAPH_ENABLED` | Graph evidence and graph recall boosts are skipped; vector and lexical recall remain available. |
| `code_graph` | enhanced | beta | `MEMORY_XX_CODE_GRAPH_ENABLED` | Repository symbol/import/call graph views are unavailable; memory graph and recall continue. |
| `temporal_decay` | full | beta | `MEMORY_XX_TEMPORAL_DECAY_ENABLED` | Temporal decay scoring and archive candidate generation are not run automatically. |
| `temporal_consolidation` | full | beta | `MEMORY_XX_CONSOLIDATION_ENABLED` | Duplicate/episode consolidation suggestions are not produced automatically. |
| `memory_dreaming` | full | experimental | `MEMORY_XX_DREAMING_ENABLED` | Background dreaming/promoted insight generation is disabled; explicit write/recall continues. |
| `policy_evaluation` | full | beta | `MEMORY_XX_POLICY_EVAL_ENABLED` | Policy evaluation reports are not refreshed automatically; runtime policy still executes. |
| `recall_quality` | full | beta | `MEMORY_XX_RECALL_QUALITY_ENABLED` | Release quality evidence is not refreshed automatically; recall still uses configured runtime paths. |
| `auto_approval_ops` | full | beta | `MEMORY_XX_AUTO_APPROVAL_ENABLED` | Pending memories remain reviewable manually; automatic approvals and sweeps do not run. |
| `auto_update_ops` | full | beta | `MEMORY_XX_AUTO_UPDATE_ENABLED` | Supersede/update candidates are not applied automatically; normal write and manual review continue. |
| `embedding_manifest` | enhanced | stable | `MEMORY_XX_EMBEDDING_MANIFEST_ENABLED` | Embedding generation validation is skipped; wrapper still uses the configured provider and Qdrant collection. |
| `embedding_calibration` | full | beta | `MEMORY_XX_EMBEDDING_CALIBRATION_ENABLED` | Embedding timeout/concurrency recommendations are not refreshed automatically. |
| `local_embedding_generation` | full | beta | `MEMORY_XX_LOCAL_EMBEDDING_GENERATION_ENABLED` | Bulk local vector regeneration is disabled; online writes still use the configured embedding provider. |
| `backup_and_restore` | full | beta | `MEMORY_XX_BACKUP_ENABLED` | Automated backup planning is unavailable; database-native backups can still be run externally. |
| `platform_doctor` | enhanced | stable | `MEMORY_XX_PLATFORM_DOCTOR_ENABLED` | Automated environment diagnosis is unavailable; health endpoints and explicit checks still work. |
| `trusted_agent_tools` | enhanced | stable | `MEMORY_XX_TRUSTED_AGENT_TOOLS_ENABLED` | Token and scope grant provisioning must be handled manually; strict scope enforcement remains available. |
| `qdrant_reconciliation` | full | beta | `MEMORY_XX_QDRANT_RECONCILE_ENABLED` | Projection repair is not run automatically; vector freshness may lag while Postgres remains authoritative. |
| `conversation_ops` | enhanced | beta | `MEMORY_XX_CONVERSATION_OPS_ENABLED` | Conversation source diagnostics and monitor reports are unavailable; direct memory APIs continue. |
| `governance_operations` | full | beta | `MEMORY_XX_GOVERNANCE_OPS_ENABLED` | Governance audits, cleanup, freeze/revert, and pending reports are not refreshed automatically; manual review APIs remain available. |
| `runtime_observability_retention` | full | beta | `MEMORY_XX_RUNTIME_OBSERVABILITY_RETENTION_ENABLED` | Runtime traces and observability artifacts are not compacted automatically; online memory operations continue. |
| `write_ticket_maintenance` | full | beta | `MEMORY_XX_WRITE_TICKET_MAINTENANCE_ENABLED` | Expired write tickets are not swept or archived automatically; new writes still use the normal idempotency path. |
| `deployment_packaging` | full | beta | `MEMORY_XX_DEPLOYMENT_PACKAGING_ENABLED` | Deployment bundle, migration preflight, and memory-specific secrets audit must be run manually or by external tooling. |
| `release_governance_gates` | full | beta | `MEMORY_XX_RELEASE_GOVERNANCE_GATES_ENABLED` | Release gates, landing/canary evidence, and capacity checks are not refreshed automatically; Core operations continue. |
| `self_improvement_ops` | full | experimental | `MEMORY_XX_SELF_IMPROVEMENT_ENABLED` | Report-only self-improvement proposals and Graphiti shadow export are disabled; normal governance and review continue. |
