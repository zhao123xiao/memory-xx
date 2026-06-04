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
EMBEDDING_MODEL=memory-xx-dev-embedding
EMBEDDING_DIMS=4096
MEMORY_XX_API_TOKEN=<set-private-token>
```

Embedding 可以使用本地模型，也可以使用 OpenAI-compatible API：

```bash
# 方案 A：远程 OpenAI-compatible embedding API。
# URL、模型名称和维度以你的 embedding provider 文档为准。
OPENAI_API_KEY=<set-private-key>
EMBEDDING_API_BASE=https://embedding-provider.example/v1
EMBEDDING_MODEL=<provider-embedding-model-name>
EMBEDDING_DIMS=4096

# 方案 B：本地 OpenAI-compatible embedding 服务。
# 按本地模型实际名称/维度设置；只有需要 systemd 管理本地 upstream 时
# 才启用 MEMORY_XX_EMBEDDING_UPSTREAM_ENABLED=1。
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=<local-embedding-model-name>
EMBEDDING_DIMS=<local-embedding-dimensions>
```

主服务读取 `OPENAI_API_KEY` 作为 OpenAI-compatible embedding API token；如果运行离线 embedding 生成或校准脚本，也可以同步设置 `EMBEDDING_API_KEY`，脚本会按各自说明读取。

如果只想先验证 Core write/project/recall 链路，可以用 `memory-xx-dev-embedding-upstream` 开发 profile 提供 deterministic OpenAI-compatible embedding。它只用于本地 smoke，不代表真实语义召回质量：

```bash
TMPDIR=/tmp npm run memory:dev-embedding-upstream
```

Docker Compose 也可以用 `dev` profile 启动同一个开发 upstream：

```bash
MEMORY_XX_DEV_EMBEDDING_DIMS=4096 \
EMBEDDING_PROXY_UPSTREAM_BASE=http://memory-xx-dev-embedding-upstream:5222/v1 \
EMBEDDING_MODEL=memory-xx-dev-embedding \
EMBEDDING_DIMS=4096 \
docker-compose --profile dev up --build -d
```

Core 数据库 schema 和 Qdrant projector 默认按 4096 维 embedding 校验。低维 dev embedding 只适合单独测试 sidecar，不适合 Core write/project/recall smoke。

如果本机已经运行 PostgreSQL、Redis、Qdrant 或其他 memory-xx 实例，可以覆盖 Compose 暴露到宿主机的端口；容器内部连接仍使用默认端口：

```bash
MEMORY_XX_WRAPPER_HOST_PORT=15100 \
MEMORY_XX_EMBEDDING_PROXY_HOST_PORT=15221 \
MEMORY_XX_DEV_EMBEDDING_HOST_PORT=15222 \
MEMORY_XX_FASTPATH_HOST_PORT=15200 \
MEMORY_XX_LEXICAL_HOST_PORT=15210 \
MEMORY_XX_QDRANT_PROXY_HOST_PORT=16334 \
MEMORY_XX_RERANKER_ADAPTER_HOST_PORT=18085 \
MEMORY_XX_CONTROL_PANEL_HOST_PORT=15310 \
MEMORY_XX_MEM0_EXTRACTOR_HOST_PORT=15220 \
MEMORY_XX_POSTGRES_HOST_PORT=15432 \
MEMORY_XX_REDIS_HOST_PORT=16379 \
MEMORY_XX_QDRANT_HOST_PORT=16333 \
docker-compose --profile dev up --build -d
```

如果要自动读取 Codex、Claude Code 或 OpenClaw 的历史会话，需要显式配置会话目录。开源模板里的 `<linux-user-home>` / `<windows-user-home>` 只是占位符，不能直接作为真实路径使用。OpenClaw 是可选 adapter；公开 landing scan / canary 默认只要求 Codex / Claude Code source，只有显式传入 `--required-source=openclaw_session` 时才把 OpenClaw 纳入阻塞条件：

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
TMPDIR=/tmp npm run test:unit-contract
TMPDIR=/tmp npm run verify:open-source
TMPDIR=/tmp npm run smoke:compose-core
TMPDIR=/tmp npm run smoke:compose-profile-live
TMPDIR=/tmp npm run smoke:runtime-profiles
TMPDIR=/tmp npm run smoke:runtime-profiles -- --live --url http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/health
TMPDIR=/tmp npm run smoke:cache-invalidation
TMPDIR=/tmp npm run smoke:write-ticket
TMPDIR=/tmp npm run smoke:markdown-projection
TMPDIR=/tmp npm run smoke:memory-dreaming
TMPDIR=/tmp npm run smoke:full-ops
TMPDIR=/tmp npm run smoke:policy-ops
TMPDIR=/tmp npm run smoke:knowledge-graph
TMPDIR=/tmp npm run smoke:qdrant-reconciliation
TMPDIR=/tmp npm run smoke:recall-quality
TMPDIR=/tmp npm run smoke:temporal-ops
TMPDIR=/tmp npm run smoke:backup-ops
TMPDIR=/tmp npm run smoke:runtime-observability
TMPDIR=/tmp npm run smoke:trusted-agent
TMPDIR=/tmp npm run smoke:embedding-ops
TMPDIR=/tmp npm run smoke:local-embedding-generation
TMPDIR=/tmp npm run smoke:governance-ops
TMPDIR=/tmp npm run smoke:self-improvement-ops
TMPDIR=/tmp npm run smoke:functional -- m1
TMPDIR=/tmp npm run check:secrets
TMPDIR=/tmp npm run audit:prod
TMPDIR=/tmp npm run memory:status -- --json
TMPDIR=/tmp npm run memory:pending -- --json
TMPDIR=/tmp npm run memory:source-mode
TMPDIR=/tmp npm run memory:qdrant-reconcile -- --json
TMPDIR=/tmp npm run memory:control-panel
```

`smoke:backup-ops` 只做 dry-run/report 验收，但 backup plan 属于 admin 操作；运行前请设置 `MEMORY_XX_CLI_TOKEN` 或 `MEMORY_XX_ADMIN_TOKEN`。
`smoke:runtime-observability` 只做 retention/report/artifact cleanup dry-run；运行前同样需要 `MEMORY_XX_CLI_TOKEN` 或 `MEMORY_XX_ADMIN_TOKEN`。
`smoke:trusted-agent` 只审计 trusted agent 和 scope grant 状态；不会注册、撤销或修改 token。
`smoke:embedding-ops` 只读取 embedding manifest 状态并执行小样本 calibration；不会切换 alias、回滚 generation 或执行本地批量向量任务。
`smoke:local-embedding-generation` 只运行 estimate-only 小样本验收；不会创建 Qdrant collection、写入 points 或更新 manifest。
`smoke:governance-ops` 只运行 pending/report/scan 类治理面；不会 apply、freeze、revert、cleanup 或修改记录。
`smoke:self-improvement-ops` 只生成 report-only self-improvement proposal、Graphiti shadow export 和 test pollution dry-run；不会写 memory、写 markdown、apply 或 cleanup。

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
- Docker Compose 默认 Core 会启动 wrapper、embedding proxy、Qdrant projector worker、PostgreSQL、Redis 和 Qdrant；宿主机端口可用 `MEMORY_XX_*_HOST_PORT` 覆盖以避开本机已有服务。
- Docker enhanced/full profile 需要同步设置 `MEMORY_XX_RUNTIME_PROFILE=enhanced/full`，否则 wrapper health、Doctor 和控制面板会按 Core 口径解释模块状态。
- Docker full profile 会包含 enhanced 服务，并暴露 Mem0、conversation monitor、cache invalidation worker、maintenance、consolidation、detect、auto-repair、repair report、landing scan、canary report 等模块；这些模块默认仍由各自 `MEMORY_XX_*_ENABLED=0` 开关关闭，按环境开启后才执行。
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
