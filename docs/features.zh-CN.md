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
- **控制面板**：本地 Web 控制台，支持运行态总览、热更新设置、图谱、审批治理、安全和平台预检。
- **Canary 与生产门禁**：支持 landing scan、7 天 canary report、P0/P1 gate、production guard 和 candidate-only exit 判断。

## 成熟度

> 详细说明见 [功能成熟度](feature-maturity.zh-CN.md)

本项目采用四级成熟度体系：

| 等级 | 标识 | 说明 |
| --- | --- | --- |
| **Stable** | 🟢 稳定 | 默认可用，可直接在生产使用 |
| **Beta** | 🟡 测试 | 可用但需人工复核，用于团队内部试运行 |
| **Experimental** | 🟠 实验 | 报告/候选为主，不建议生产自动化依赖 |
| **Dangerous** | 🔴 高风险 | 会批量修改数据，必须先 dry-run 再 apply |

| 功能 | 成熟度 | 说明 |
| --- | --- | --- |
| PostgreSQL 写入账本 | 🟢 Stable | 核心事实源，配套 migration 和测试 |
| Embedding generation | 🟢 Stable | 最小可用链路的必需项 |
| Review lifecycle | 🟢 Stable | approve / reject / archive / supersede / tombstone |
| Qdrant projection | 🟢 Stable | 通过 outbox worker 保持投影一致 |
| Recall API | 🟢 Stable | 支持 Qdrant primary 与 PostgreSQL fallback |
| Scope / trusted agent | 🟢 Stable | 支持 agent token、scope grant 和 strict mode |
| MCP / Agent tools | 🟢 Stable | 支持 scoped recall/write/review/feedback |
| Qdrant audit/reconcile (只读) | 🟢 Stable | collection audit、alias 管理 |
| Policy engine | 🟡 Beta | 支持 reject/quarantine/pending/approve |
| Auto approval (scoped) | 🟡 Beta | 支持 production guard、scope enablement |
| Auto update (dry-run) | 🟡 Beta | 仅 dry-run 模式，apply 为 Dangerous |
| Memory knowledge graph | 🟡 Beta | episodes、entities、relations、graph health |
| Code Graph | 🟠 Experimental | 项目隔离测试，项目级代码图谱 |
| Conversation ingest | 🟡 Beta | Codex / Claude Code / OpenClaw session tail |
| Knowledge ingest | 🟡 Beta | 知识库导入和检索 |
| Control panel | 🟡 Beta | 本地运维工具，建议仅本地访问 |
| Temporal governance | 🟠 Experimental | 时间策略、衰减、整合候选 |
| Graph recall / dreaming | 🟠 Experimental | 图谱召回、记忆梦境 |
| 7d canary / production gate | 🟠 Experimental | 适合受控试运行 |
| Auto update apply | 🔴 Dangerous | 真实 apply 修改记忆状态，需先 dry-run |
| Qdrant reconcile apply | 🔴 Dangerous | 向量对账 apply，需先 dry-run |
| Bulk tombstone | 🔴 Dangerous | 批量墓碑删除，不可恢复 |

## 默认安全边界

- 不默认开放 global 自动写入。
- 不默认开放 real update/supersede/apply。
- `candidate_only` 可作为全局 kill switch。
- `test_only`、`audit_only`、`explicit_only`、`never` 不进入默认召回。
- archived、superseded、tombstone 记录保留在 PostgreSQL 历史账本，不保留 active Qdrant 点。
