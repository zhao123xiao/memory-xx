# memory-xx

`memory-xx` 是一套面向本地 AI Agent 的长期记忆框架：PostgreSQL 负责事实账本，Qdrant 负责向量召回投影，Policy Engine 负责写入治理，Control Panel 负责运行控制，HTTP / MCP 接口负责给 Codex、Claude Code、OpenClaw 或其他 Agent 使用。

当前版本来自一套已长期运行的私有记忆系统的 clean export。核心能力已经导出到 `memory-xx`，但公开文档和通用部署体验仍在整理中，因此建议按 **public preview / alpha** 使用。

> 兼容说明：项目名称是 `memory-xx`，但环境变量前缀 `MEMORY_V2_*` 和 API 路径 `/api/memory/v2` 仍作为兼容接口保留。

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
MEMORY_V2_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/memory_xx
MEMORY_V2_DATABASE_SCHEMA=memory_xx
MEMORY_V2_REDIS_URL=redis://127.0.0.1:6379/0
MEMORY_V2_QDRANT_BASE_URL=http://127.0.0.1:6333
MEMORY_V2_QDRANT_COLLECTION=memory-xx-active
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=Qwen3-Embedding-8B
EMBEDDING_DIMS=4096
MEMORY_V2_API_TOKEN=<set-private-token>
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
curl http://127.0.0.1:${MEMORY_V2_WRAPPER_PORT:-5100}/live
curl -H "Authorization: Bearer $MEMORY_V2_API_TOKEN" \
  http://127.0.0.1:${MEMORY_V2_WRAPPER_PORT:-5100}/health
```

WSL 用户建议运行 npm/tsx 命令时加 `TMPDIR=/tmp`。

更完整的启动说明见 [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md)。

## 最小 API 示例

写入一条记忆：

```bash
curl -X POST "http://127.0.0.1:${MEMORY_V2_WRAPPER_PORT:-5100}/api/memory/v2/write" \
  -H "Authorization: Bearer $MEMORY_V2_API_TOKEN" \
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
curl -X POST "http://127.0.0.1:${MEMORY_V2_WRAPPER_PORT:-5100}/api/memory/v2/recall/query" \
  -H "Authorization: Bearer $MEMORY_V2_API_TOKEN" \
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
TMPDIR=/tmp npm run check:secrets
TMPDIR=/tmp npm run audit:prod
TMPDIR=/tmp npm run memory:status -- --json
TMPDIR=/tmp npm run memory:pending -- --json
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

## 当前状态与边界

- 本仓库是 public preview / alpha。
- Embedding 是必需组件；reranker 是增强组件。
- Docker Compose 当前仍建议作为模板使用，发布生产镜像前需要按实际端口和依赖校准。
- global 自动写入默认不建议开启。
- real update/supersede/apply 默认不建议开启，应先 dry-run 或 canary。
- 控制面板是本地运维工具，建议只绑定 `127.0.0.1`，不要直接暴露公网。

## 开源安全说明

不要提交以下内容：

- `.env`、真实 token、真实 provider key
- `.runtime/`
- `reports/`
- `logs/`
- `data/`
- 数据库 dump
- 真实会话 JSONL
- 真实用户记忆
- benchmark 原始数据

发布前建议运行：

```bash
TMPDIR=/tmp npm run verify:open-source
TMPDIR=/tmp npm run check:secrets
TMPDIR=/tmp npm run audit:prod
rg -n "<linux-user-home>|<windows-user-home>|<api-key>|Bearer " .
```

`test:gates` / `test:all-gates` 是 runtime gate，需要真实
`MEMORY_V2_DATABASE_URL`、`MEMORY_V2_API_TOKEN` 等运行环境变量；普通开源检查请使用
`verify:open-source`。

## 许可证

MIT。见 [LICENSE](LICENSE)。
