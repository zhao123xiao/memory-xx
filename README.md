# memory-xx

`memory-xx` 是一套面向本地 AI Agent、个人工作流和多 Agent 系统的长期记忆框架。它把 PostgreSQL 作为事实账本，把 Qdrant 作为向量召回投影，把 Redis 用于缓存和协同，并通过 HTTP / MCP 接口提供 write、recall、review、agent token、治理和运行状态能力。

当前公开版本是 `v0.1.0` public preview。仓库已经统一使用 `MEMORY_XX_*` 环境变量前缀和 `/api/memory/xx` API 路径，包含 Core、enhanced、full 三类运行 profile。Core 能完成基础写入、投影和召回；enhanced/full 模块按环境热插拔，关闭或降级时不应阻断 Core write/recall。

## 它解决什么问题

普通 RAG 或向量库通常只处理“存文本”和“相似搜索”。长期记忆系统还需要解决更多运行问题：

- 哪些内容应该写入，哪些应该拒绝、隔离、等待人工审批或只进入审计证据。
- 记忆如何被批准、归档、替换、回滚、重新投影到向量库。
- 多个 Agent 如何共享记忆，同时保持 user、project、workspace、global 等 scope 边界。
- embedding、Qdrant、Redis、worker、policy、pending、canary 等运行状态如何观察和治理。
- 当 reranker、fastpath、lexical、Mem0、conversation monitor 等增强组件不可用时，系统如何降级而不是整体不可用。

## 当前真实状态

- **Core 可运行**：wrapper、PostgreSQL、Redis、Qdrant、embedding proxy、Qdrant projector 是最小链路。
- **向量 embedding 必需**：需要 OpenAI-compatible embedding endpoint；远程 provider 使用 `OPENAI_API_KEY`，本地 provider 也需要暴露兼容 `/v1/embeddings` 的接口。
- **热插拔 profile 已公开**：`core`、`enhanced`、`full` profile 都有公开配置和 Compose 入口。
- **sidecar 已开源**：embedding proxy、Qdrant proxy、reranker adapter、Mem0 extractor、fastpath、lexical sidecar 在 `sidecars/` 下提供公开实现。
- **full-stack 能力是可选能力包**：知识库、知识图谱、Code Graph、temporal、dreaming、policy evaluation、recall quality、backup、governance、observability、self-improvement 等能力已进入公开模块清单，但需要按环境逐项开启。
- **public preview 边界**：这不是托管服务，也不是零配置产品；用户仍需要准备 PostgreSQL、Redis、Qdrant 和 embedding provider。

## 功能与模块

### Core

Core 是最小可运行记忆链路：

- HTTP / MCP wrapper
- PostgreSQL truth ledger
- Redis cache / coordination
- Qdrant active projection
- embedding proxy
- Qdrant projector worker
- write / recall / review / approve / reject / archive / health

Core 目标是稳定完成“写入事实账本 -> 生成 embedding -> 投影 Qdrant -> 召回候选 -> 返回给 Agent”。

### Enhanced

Enhanced 面向更好的召回质量、延迟和接入体验，模块可以按需开启：

- fastpath recall
- lexical sidecar
- Qdrant proxy
- reranker adapter / upstream
- Mem0 extractor
- conversation monitor
- trusted agent tooling
- control panel
- platform doctor

这些模块不可用时，系统应回退到 Core 路径。

### Full

Full 面向完整治理和生产化运行，包含更多后台、审计和质量能力：

- Knowledge ingest
- Memory knowledge graph / Code Graph
- temporal decay / consolidation
- memory dreaming
- policy evaluation
- recall quality
- auto approval / auto update ops
- embedding manifest / calibration / local generation
- backup and restore planning
- Qdrant reconciliation
- governance operations
- runtime observability retention
- write ticket maintenance
- release governance gates
- self-improvement ops

Full 能力默认不应影响 Core 可用性。需要某个模块时，先配置对应依赖和 `MEMORY_XX_*_ENABLED` 开关，再通过 health、Doctor 或 operations 文档确认状态。

## 架构概览

```text
Agent / API / MCP
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
                 +--> governance / graph / audit / lifecycle
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

## 快速体验

最小依赖：

- Node.js 20+
- PostgreSQL 16
- Redis 7+
- Qdrant
- OpenAI-compatible embedding endpoint

安装依赖并复制配置：

```bash
npm install
cp configs/memory-xx.env.example .env.local
```

至少配置这些变量：

```bash
MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/memory_xx
MEMORY_XX_DATABASE_SCHEMA=memory_xx
MEMORY_XX_REDIS_URL=redis://127.0.0.1:6379/0
MEMORY_XX_QDRANT_BASE_URL=http://127.0.0.1:6333
MEMORY_XX_QDRANT_COLLECTION=memory-xx-active
EMBEDDING_API_BASE=https://embedding-provider.example/v1
EMBEDDING_MODEL=<provider-embedding-model-name>
EMBEDDING_DIMS=<provider-embedding-dimensions>
OPENAI_API_KEY=<set-private-key>
MEMORY_XX_API_TOKEN=<set-private-token>
```

本地模型也可以使用，只要它提供 OpenAI-compatible embedding API。仓库内的 dev embedding upstream 只适合本地 smoke 和链路验证，不代表真实语义召回质量。

启动：

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

如果想用 Compose 启动本地 Core 链路，见 [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md)。WSL 用户建议运行 npm/tsx 命令时加 `TMPDIR=/tmp`。

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

Strict scope 默认开启。上面的示例便于本地理解接口；如果 scoped 操作返回 403，请使用 trusted agent / MCP token / admin token，或仅在本地调试时临时设置 `MEMORY_XX_SCOPE_POLICY_MODE=single_user`。

## Agent 会话接入

memory-xx 可以显式读取 Codex、Claude Code 或 OpenClaw 的历史会话目录。OpenClaw 是可选 adapter；公开 landing scan / canary 默认只要求 Codex / Claude Code source，只有显式传入 `--required-source=openclaw_session` 时才把 OpenClaw 纳入阻塞条件。

```bash
MEMORY_XX_CODEX_SESSION_ROOTS=/home/<user>/.codex/sessions
MEMORY_XX_CLAUDE_SESSION_ROOTS=/home/<user>/.claude/projects
MEMORY_XX_OPENCLAW_SESSION_ROOTS=/home/<user>/.openclaw/agents/main/sessions
```

开源配置中的 `<linux-user-home>` / `<windows-user-home>` 只是占位符，使用前需要替换成真实路径。

## 运行边界

- Embedding 是必需组件；reranker 是增强组件。
- Qdrant 是 Core 召回投影依赖；PostgreSQL 仍是事实源。
- Redis 不可用时缓存和协同能力会降级，但不应替代 PostgreSQL 的事实状态。
- fastpath、lexical、reranker、Mem0、conversation monitor、control panel 是可选增强模块。
- Control Panel 是本地运维界面，建议只绑定 `127.0.0.1`，不要直接暴露公网。
- Markdown projection 是只读 review/export 投影，不支持反向同步。
- global 自动写入默认不建议开启。
- real update / supersede / apply 默认不建议直接开启，应先 dry-run 或 canary。

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
| Operations guide | [docs/operations.md](docs/operations.md) |
| Knowledge 文档治理 | [docs/knowledge.zh-CN.md](docs/knowledge.zh-CN.md) |
| Canary 与生产就绪 | [docs/canary.zh-CN.md](docs/canary.zh-CN.md) |
| API 参考 | [docs/api.md](docs/api.md) |
| Runtime profile | [docs/runtime-profiles.md](docs/runtime-profiles.md) |
| Module catalog | [docs/module-catalog.md](docs/module-catalog.md) |
| Release notes | [CHANGELOG.md](CHANGELOG.md) |
| Open-source release checklist | [docs/release-checklist.md](docs/release-checklist.md) |

## 许可证

MIT。见 [LICENSE](LICENSE)。
