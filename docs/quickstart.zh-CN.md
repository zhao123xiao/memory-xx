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

`MEMORY_V2_*` 是兼容前缀，项目名称仍是 `memory-xx`。

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
curl http://127.0.0.1:${MEMORY_V2_WRAPPER_PORT:-5100}/live
curl -H "Authorization: Bearer $MEMORY_V2_API_TOKEN" \
  http://127.0.0.1:${MEMORY_V2_WRAPPER_PORT:-5100}/health
```

## 写入和召回示例

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

## 基础验证

```bash
TMPDIR=/tmp npm run memory:status -- --json
TMPDIR=/tmp npm run memory:pending -- --json
TMPDIR=/tmp npm run memory:qdrant-reconcile -- --json
```
