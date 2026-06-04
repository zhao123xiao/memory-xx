# 快速启动

本文给出最小本地启动路径。Docker Compose 当前仍建议作为模板使用；公开预览版优先推荐 npm 本地启动，方便排查依赖和端口。

## 最小依赖

- Node.js 20+
- PostgreSQL 16，建议使用 pgvector 镜像
- Redis 7+
- Qdrant
- Embedding 模型或 OpenAI-compatible embedding endpoint，必需
- 可选：reranker 模型、Mem0 extractor、Codex / Claude Code / OpenClaw session source

WSL 用户建议运行 npm/tsx 命令时加 `TMPDIR=/tmp`，避免 tsx socket 放在 Windows 文件系统导致异常。

## 安装依赖

```bash
npm install
```

## 配置环境变量

复制配置模板：

```bash
cp configs/memory-xx.env.example .env.local
```

至少需要配置：

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

公开版统一使用 `MEMORY_XX_*` 环境变量前缀和 `/api/memory/xx` API 路径。

## Embedding 配置

Embedding 是必需组件。可以使用本地模型，也可以使用 OpenAI-compatible 远程 API。

本地服务示例：

```bash
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=Qwen3-Embedding-8B
EMBEDDING_DIMS=4096
```

远程 API 示例：

```bash
OPENAI_API_KEY=<set-private-key>
EMBEDDING_API_BASE=https://embedding-provider.example/v1
EMBEDDING_MODEL=<embedding-model-name>
EMBEDDING_DIMS=<embedding-dimensions>
```

主服务读取 `OPENAI_API_KEY` 作为 OpenAI-compatible embedding API token；部分离线脚本也支持 `EMBEDDING_API_KEY`，如需运行这些脚本可同步设置。

远程 embedding provider 可以使用任何 OpenAI-compatible API；价格、可用模型、输出维度和速率限制以 provider 文档为准。

如果只想先验证 Core 链路，可以启用开发用 deterministic embedding upstream。它只用于本地 smoke，不代表真实语义召回质量：

```bash
TMPDIR=/tmp npm run memory:dev-embedding-upstream
```

Docker Compose 场景可以用 `dev` profile 启动同一个开发 upstream：

```bash
MEMORY_XX_DEV_EMBEDDING_DIMS=4096 \
EMBEDDING_PROXY_UPSTREAM_BASE=http://memory-xx-dev-embedding-upstream:5222/v1 \
EMBEDDING_MODEL=memory-xx-dev-embedding \
EMBEDDING_DIMS=4096 \
docker-compose --profile dev up --build -d memory-xx-dev-embedding-upstream memory-xx-embedding-proxy
```

Core 数据库 schema 和 Qdrant projector 默认按 4096 维 embedding 校验。低维 dev embedding 只适合单独测试 sidecar，不适合 Core write/project/recall smoke。

## 会话来源目录

如果要自动读取 Codex、Claude Code 或 OpenClaw 历史会话，需要显式配置会话目录。开源模板里的 `<linux-user-home>` / `<windows-user-home>` 只是占位符，不能直接作为真实路径使用。

```bash
MEMORY_XX_CODEX_SESSION_ROOTS=/home/<user>/.codex/sessions
MEMORY_XX_CLAUDE_SESSION_ROOTS=/home/<user>/.claude/projects
MEMORY_XX_OPENCLAW_SESSION_ROOTS=/home/<user>/.openclaw/agents/main/sessions
```

## 迁移数据库

```bash
set -a
. ./.env.local
set +a
TMPDIR=/tmp npm run migrate
```

## 启动服务

```bash
TMPDIR=/tmp npm start
```

检查服务：

```bash
curl http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/live
curl -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  http://127.0.0.1:${MEMORY_XX_WRAPPER_PORT:-5100}/health
```

Strict scope 默认开启。下面的最小 API 示例使用 `MEMORY_XX_API_TOKEN` 便于本地理解接口；如果 scoped 操作返回 403，请使用 trusted agent / MCP token / admin token，或仅在本地调试时临时设置 `MEMORY_XX_SCOPE_POLICY_MODE=single_user`。

## 写入和召回示例

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

## 基础验证

```bash
TMPDIR=/tmp npm run memory:status -- --json
TMPDIR=/tmp npm run memory:pending -- --json
TMPDIR=/tmp npm run memory:qdrant-reconcile -- --json
TMPDIR=/tmp npm run smoke:functional -- m1
```

## Docker Compose

默认 Compose 启动 Core 路径：wrapper、embedding proxy、Qdrant projector worker、PostgreSQL、Redis、Qdrant。

```bash
TMPDIR=/tmp npm run smoke:compose-core
docker-compose up --build -d
```

没有真实 embedding provider 时，可以先用 dev profile 验证 Core 布线：

```bash
MEMORY_XX_DEV_EMBEDDING_DIMS=4096 \
EMBEDDING_PROXY_UPSTREAM_BASE=http://memory-xx-dev-embedding-upstream:5222/v1 \
EMBEDDING_MODEL=memory-xx-dev-embedding \
EMBEDDING_DIMS=4096 \
docker-compose --profile dev up --build -d
```

Core 数据库 schema 和 Qdrant projector 默认按 4096 维 embedding 校验。低维 dev embedding 只适合单独测试 sidecar，不适合 Core write/project/recall smoke。

如果本机已经有 PostgreSQL、Redis、Qdrant 或其他 memory-xx 实例占用默认端口，可以覆盖 Compose 暴露到宿主机的端口；容器之间的连接仍使用 `postgres:5432`、`redis:6379`、`qdrant:6333` 和默认服务名：

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

增强模块通过 profile 启动：

```bash
MEMORY_XX_RUNTIME_PROFILE=enhanced docker-compose --profile enhanced up --build -d
MEMORY_XX_RUNTIME_PROFILE=full docker-compose --profile enhanced --profile full up --build -d
```

`enhanced` 会额外启动 fastpath、lexical sidecar、Qdrant proxy、reranker adapter 和本地控制面板；`full` 会再暴露 Mem0 extractor、conversation monitor、cache invalidation worker，以及 maintenance、consolidation、detect、auto-repair、repair report、landing scan、canary report 等运维/门禁模块。这些 full 模块默认仍由各自 `MEMORY_XX_*_ENABLED=0` 开关关闭，按环境开启后才执行。模型上游仍需要按本机环境配置，例如 `EMBEDDING_PROXY_UPSTREAM_BASE`、`OPENAI_API_KEY`、reranker downstream URL 和 Mem0/LLM 参数。
