# 功能总览

`memory-xx` 是一套面向本地 AI Agent 的长期记忆框架。它不是单纯的向量库，也不是只把对话摘要保存下来，而是把写入、审批、召回、知识库、图谱、运行观测和安全边界放在同一套可治理链路里。

## 核心能力

- **PostgreSQL 事实账本**：`memory_records`、事件、outbox、feedback、trusted agent、knowledge 等数据以数据库为事实源。
- **Embedding 驱动的向量召回**：embedding 模型是必需组件，用于把记忆、查询和知识块转换成向量。
- **Qdrant 向量投影**：只把符合策略的 current / approved / default recall 记忆投影到 active vector collection。
- **Reranker 召回增强**：reranker 模型是增强项，用于对候选结果重排序。
- **记忆生命周期治理**：支持 approve、reject、archive、supersede、tombstone、update candidate、rollback、repair、reconcile。
- **Policy Engine 与自动审批**：从 extraction 到 reject / quarantine / pending / approve 全链路治理。
- **记忆知识图谱**：基于 episodes、entities、entity links、relations 形成图谱证据。
- **Code Graph**：扫描代码仓库，生成 repository / file / symbol / import / declaration / call reference 等节点和边。
- **多 Agent / MCP 接入**：支持 scoped recall、write、pending review、feedback 和 orchestrator tools。
- **Knowledge 层**：把长文档、教程、报告、runbook、项目知识和短事实 memory 分离。
- **Markdown Projection**：把 PostgreSQL 事实账本导出为只读 Markdown review/export 视图。
- **控制面板**：本地 Web 控制台，支持运行态总览、热更新设置、图谱、审批治理、安全和平台预检。
- **Canary 与生产门禁**：支持 landing scan、7 天 canary report、P0/P1 gate、production guard 和 candidate-only exit 判断。

## 成熟度

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| PostgreSQL 写入账本 | Stable | 核心事实源，配套 migration 和测试。 |
| Embedding generation | Stable | 最小可用链路的必需项。 |
| Review lifecycle | Stable | approve / reject / archive / supersede / tombstone 已实现。 |
| Qdrant projection | Stable | 通过 outbox worker 和 reconcile 保持投影一致。 |
| Recall API | Stable | 支持 Qdrant primary 与 PostgreSQL fallback。 |
| Scope / trusted agent | Stable | 支持 agent token、scope grant 和 strict mode。 |
| MCP / Agent tools | Beta | 支持 scoped recall/write/review/feedback。 |
| Policy engine | Beta | 支持 reject/quarantine/pending/approve。 |
| Auto approval | Beta | 支持 production guard、candidate-only、scope bypass 和 runtime controls。 |
| Memory knowledge graph | Beta | 支持 episodes、entities、relations、graph report、graph health 和控制面板图谱视图。 |
| Code Graph | Beta | 支持扫描代码仓库并生成项目级代码图谱。 |
| Conversation ingest | Beta | Codex / Claude Code / OpenClaw session tail 已实现，外部环境需要自行配置路径。 |
| Knowledge ingest | Beta | 支持知识库导入和检索，文档整理策略仍在完善。 |
| Markdown projection / source mode | Beta | 支持只读 Markdown 投影视图和 drift 检查；PostgreSQL 始终是事实源。 |
| Control panel | Beta | 支持运行态总览、服务开关、热更新设置、审批控制、图谱、平台预检和安全审计。 |
| Temporal governance | Beta | 支持 memory layer、fact status、memory strength、episodes、entities、relations、decay 和 consolidation。 |
| 7d canary / production gate | Experimental | 适合受控试运行，不应作为默认生产开关。 |
| Auto update / supersede apply | Experimental | 真实生产 apply 默认不建议开启。 |
| Graph recall / memory dreaming | Experimental | 已有代码和脚本，但公开用户应谨慎启用。 |

## 默认安全边界

- 非服务型 full-stack 能力包由 `app/full-stack-capabilities.ts` 声明。它覆盖 Knowledge ingest、Memory knowledge graph、Code Graph、Temporal decay/consolidation、Memory dreaming、Policy evaluation、Recall quality 等模块，开源发布门禁会检查这些源码和 CLI 是否随仓库导出。
- 不默认开放 global 自动写入。
- 不默认开放 real update/supersede/apply。
- `candidate_only` 可作为全局 kill switch。
- `test_only`、`audit_only`、`explicit_only`、`never` 不进入默认召回。
- archived、superseded、tombstone 记录保留在 PostgreSQL 历史账本，不保留 active Qdrant 点。
