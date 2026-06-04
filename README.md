# memory-xx

`memory-xx` 是一套面向本地 AI Agent 的长期记忆框架：PostgreSQL 负责事实账本，Qdrant 负责向量召回投影，Policy Engine 负责写入治理，Control Panel 负责运行控制，HTTP / MCP 接口负责给 Codex、Claude Code、OpenClaw 或其他 Agent 使用。

当前版本来自一套已长期运行的私有记忆系统的 clean export。核心能力已经导出到 `memory-xx`，但公开文档和通用部署体验仍在整理中，因此建议按 **public preview / alpha** 使用。

公开版统一使用 `MEMORY_XX_*` 环境变量前缀和 `/api/memory/xx` API 路径。

## 它解决什么问题

普通 RAG 或向量库通常只解决“把文本放进去，再相似搜索出来”。memory-xx 额外处理长期记忆系统必须面对的问题：

- 哪些内容应该写入，哪些应该拒绝、隔离或等待人工审批。
- 哪些记忆能进入默认召回，哪些只能显式召回或只作为审计证据。
- 记忆如何被更新、归档、替换、回滚和投影到向量库。
- 多个 Agent 如何共享记忆，同时保持 scope、token 和权限边界。
- 运行中的 embedding、Qdrant、worker、policy、pending、canary 状态如何被观察和治理。

## 核心能力

- **事实账本**：PostgreSQL 保存 memory、event、outbox、feedback、trusted agent、knowledge。
- **向量召回**：embedding 模型是必需项，Qdrant 保存 current / approved / default recall 的 active 投影。
- **召回增强**：reranker、lexical、graph recall、code graph 可提升复杂查询质量。
- **写入治理**：Policy Engine 支持 reject、quarantine、pending、approve 和自动审批 sweep。
- **生命周期**：支持 approve、reject、archive、supersede、tombstone、update candidate、rollback。
- **多 Agent 接入**：HTTP / MCP / trusted agent / scope grant 支持多 Agent 共享。
- **知识库**：长文档进入 `knowledge_v1`，短事实进入 memory，避免长报告污染默认召回。
- **图谱能力**：支持记忆知识图谱和项目级 Code Graph。
- **Markdown 投影**：可选导出只读 Markdown review/export 视图，PostgreSQL 仍是事实源。
- **控制面板**：本地 Web 控制台支持运行总览、热更新配置、审批治理、图谱和平台预检。
- **生产门禁**：支持 landing scan、7 天 canary、P0/P1 gate、Qdrant reconcile、production guard。

## 架构概览

```text
Conversation / API / MCP
        |
        v
Extraction + Policy Engine
        |
        +--> reject / quarantine / pending
        |
        +--> approved memory
                 |
                 v
          PostgreSQL truth ledger
                 |
                 +--> temporal governance / knowledge graph / audit
                 |
                 v
        embedding generation + Qdrant projection
                 |
                 v
       recall candidates + optional reranker
                 |
                 v
        Agent tools / HTTP API / Control Panel
```

## 快速启动

最小依赖：

- Node.js 20+
- PostgreSQL 16，建议使用 pgvector 镜像
- Redis 7+
- Qdrant
- OpenAI-compatible embedding endpoint，必需
- reranker 可选

安装依赖：

```bash
npm install
```

复制配置：

```bash
cp configs/memory-xx.env.example .env.local
```

至少配置：

```bash
MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/memory_xx
MEMORY_XX_DATABASE_SCHEMA=memory_xx
MEMORY_XX_REDIS_URL=redis://127.0.0.1:6379/0
MEMORY_XX_QDRANT_BASE_URL=http://127.0.0.1:6333
MEMORY_XX_QDRANT_COLLECTION=memory-xx-active
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=Qwen3-Embedding-8B
EMBEDDING_DIMS=4096
MEMORY_XX_API_TOKEN=<set-private-token>
```

Embedding 可以使用本地模型，也可以使用 OpenAI-compatible API：

```bash
# 方案 A：本地 embedding 服务
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=Qwen3-Embedding-8B
EMBEDDING_DIMS=4096

# 方案 B：远程 OpenAI-compatible embedding API。
# URL、模型名称和维度以你的 embedding provider 文档为准。
OPENAI_API_KEY=<set-private-key>
EMBEDDING_API_BASE=https://embedding-provider.example/v1
EMBEDDING_MODEL=<embedding-model-name>
EMBEDDING_DIMS=<embedding-dimensions>
```

主服务读取 `OPENAI_API_KEY` 作为 OpenAI-compatible embedding API token；如果运行离线 embedding 生成或校准脚本，也可以同步设置 `EMBEDDING_API_KEY`，脚本会按各自说明读取。

如果要自动读取 Codex、Claude Code 或 OpenClaw 的历史会话，需要显式配置会话目录。开源模板里的 `<linux-user-home>` / `<windows-user-home>` 只是占位符，不能直接作为真实路径使用：

```bash
MEMORY_XX_CODEX_SESSION_ROOTS=/home/<user>/.codex/sessions
MEMORY_XX_CLAUDE_SESSION_ROOTS=/home/<user>/.claude/projects
MEMORY_XX_OPENCLAW_SESSION_ROOTS=/home/<user>/.openclaw/agents/main/sessions
```

迁移并启动：

```bash
set -a
. ./.env.local
set +a
TMPDIR=/tmp npm run migrate
TMPDIR=/tmp npm start
```

检查服务：

```bash
curl http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/live
curl -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/health
```

WSL 用户建议运行 npm/tsx 命令时加 `TMPDIR=/tmp`。

更完整的启动说明见 [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md)。

## 最小 API 示例

写入一条记忆：

```bash
curl -X POST "http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/api/memory/xx/write" \
  -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "用户偏好：默认使用中文回复技术问题。",
    "scope_type": "user",
    "scope_id": "local-user",
    "metadata": {
      "source": "manual-example"
    }
  }'
```

召回记忆：

```bash
curl -X POST "http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/api/memory/xx/recall/query" \
  -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "用户希望用什么语言回复？",
    "scope": {
      "user_id": "local-user"
    },
    "limit": 5
  }'
```

## 常用命令

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run verify:open-source
TMPDIR=/tmp npm run smoke:runtime-profiles
TMPDIR=/tmp npm run smoke:runtime-profiles -- --live --url http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/health
TMPDIR=/tmp npm run check:secrets
TMPDIR=/tmp npm run audit:prod
TMPDIR=/tmp npm run memory:status -- --json
TMPDIR=/tmp npm run memory:pending -- --json
TMPDIR=/tmp npm run memory:source-mode
TMPDIR=/tmp npm run memory:qdrant-reconcile -- --json
TMPDIR=/tmp npm run memory:control-panel
```

## 文档导航

| 想了解 | 文档 |
| --- | --- |
| 快速启动 | [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md) |
| 完整功能清单 | [docs/features.zh-CN.md](docs/features.zh-CN.md) |
| 架构和数据流 | [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) |
| Agent / MCP 接入 | [docs/agent-integration.zh-CN.md](docs/agent-integration.zh-CN.md) |
| Policy Engine、自动审批、Supersede | [docs/policy-governance.zh-CN.md](docs/policy-governance.zh-CN.md) |
| Embedding、Reranker、Qdrant Alias | [docs/vector-runtime.zh-CN.md](docs/vector-runtime.zh-CN.md) |
| 控制面板和热插拔配置 | [docs/control-panel.zh-CN.md](docs/control-panel.zh-CN.md) |
| Worker、备份、迁移、systemd、平台检查 | [docs/operations.zh-CN.md](docs/operations.zh-CN.md) |
| Knowledge 文档治理 | [docs/knowledge.zh-CN.md](docs/knowledge.zh-CN.md) |
| Canary 与生产就绪 | [docs/canary.zh-CN.md](docs/canary.zh-CN.md) |
| API 参考 | [docs/api.md](docs/api.md) |
| Runtime profile | [docs/runtime-profiles.md](docs/runtime-profiles.md) |
| Module catalog | [docs/module-catalog.md](docs/module-catalog.md) |

## 当前状态与边界

- 本仓库是 public preview / alpha。
- Embedding 是必需组件；reranker 是增强组件。
- Docker Compose 当前仍建议作为模板使用，发布生产镜像前需要按实际端口和依赖校准；默认 Core 会启动 wrapper、embedding proxy、Qdrant projector worker、PostgreSQL、Redis 和 Qdrant。
- Docker enhanced/full profile 需要同步设置 `MEMORY_XX_RUNTIME_PROFILE=enhanced/full`，否则 wrapper health、Doctor 和控制面板会按 Core 口径解释模块状态。
- Docker full profile 会暴露 Mem0、conversation monitor、cache invalidation worker、maintenance、consolidation、detect、auto-repair、repair report、landing scan、canary report 等模块；这些模块默认仍由各自 `MEMORY_XX_*_ENABLED=0` 开关关闭，按环境开启后才执行。
- `sidecars/` 已纳入 embedding proxy、Qdrant proxy、reranker adapter、Mem0 extractor、fastpath、lexical sidecar 的公开源码；这些模块可按环境开启、关闭或降级。
- fastpath 和 lexical sidecar 当前提供 Node.js 开源实现，部署环境可替换为更高性能实现，但必须保持 HTTP 契约兼容；禁用它们不影响 core write/recall。
- Markdown projection 是 full-stack 可插拔模块，可用 `MEMORY_XX_MARKDOWN_PROJECTION_ENABLED=1` 开启；导出的 Markdown 是 review/export 投影，不支持反向同步。
- `app/full-stack-capabilities.ts` 记录非服务型 full-stack 能力包，例如 Knowledge ingest、Memory/Code Graph、Temporal decay/consolidation、Memory dreaming、Policy evaluation、Recall quality、auto-approval/update ops、embedding manifest/calibration、本地 embedding 生成、backup、platform doctor、trusted agent tooling、Qdrant reconciliation、conversation ops、governance operations、runtime observability retention、write-ticket maintenance、deployment/security packaging、release governance gates 和 self-improvement ops；这些能力默认不影响 Core，可按环境开启或只运行 CLI。
- global 自动写入默认不建议开启。
- real update/supersede/apply 默认不建议开启，应先 dry-run 或 canary。
- 控制面板是本地运维工具，建议只绑定 `127.0.0.1`，不要直接暴露公网。

Strict scope 默认开启。最小 API 示例使用 `MEMORY_XX_API_TOKEN` 便于本地理解接口；如果 scoped 操作返回 403，请使用 trusted agent / MCP token / admin token，或仅在本地调试时临时设置 `MEMORY_XX_SCOPE_POLICY_MODE=single_user`。

## 许可证

MIT。见 [LICENSE](LICENSE)。
