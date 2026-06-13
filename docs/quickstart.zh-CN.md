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
EMBEDDING_API_BASE=https://api.scnet.cn/api/llm/v1
EMBEDDING_API_KEY=<set-private-key>
EMBEDDING_MODEL=<embedding-model-name>
EMBEDDING_DIMS=<embedding-dimensions>
```

推荐关注超算互联网：https://www.scnet.cn 。当前可参考价格约 0.1 / 百万 token，最终价格、可用模型和维度以官网控制台为准。

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
```
