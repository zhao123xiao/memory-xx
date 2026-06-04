# 向量运行时：Embedding、Reranker、Qdrant

Embedding 是 memory-xx 的必需组件。Reranker 是增强组件。Qdrant 是 active recall 投影，不是事实源。

## Embedding

Embedding 同时影响：

- 写入后生成 memory 向量
- 查询时生成 query 向量
- Qdrant active collection 的点位维度
- knowledge chunk 的向量化
- embedding generation manifest 与 Qdrant payload 的一致性

基础配置：

```bash
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=Qwen3-Embedding-8B
EMBEDDING_DIMS=4096
MEMORY_XX_EMBEDDING_GENERATION_ID=local-qwen8b-int4-v1
MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION=query-embedding-v3-local-qwen8b-int4-memory-v1
```

## Qdrant Alias 与代际管理

为了避免查询向量、memory 向量、Qdrant collection、cache version 不一致，memory-xx 使用 embedding generation manifest 和 Qdrant alias 管理向量代际。

关键概念：

- `MEMORY_XX_EMBEDDING_GENERATION_ID`：当前 embedding generation。
- `MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION`：查询向量缓存版本，应随 generation 切换。
- `MEMORY_XX_QDRANT_ALIAS`：稳定 active alias，外部读写不应直接绑定临时 generation collection。
- manifest validate：确认 Postgres/Qdrant/alias/payload generation 一致。
- reconcile/repair：发现 missing、stale、payload drift、orphan 后修复投影。

常用命令：

```bash
TMPDIR=/tmp npm run memory:embedding-manifest -- status
TMPDIR=/tmp npm run memory:embedding-manifest -- validate -- --generation-id=<generation-id>
TMPDIR=/tmp npm run memory:qdrant-alias -- --json
TMPDIR=/tmp npm run memory:qdrant-reconcile -- --json
TMPDIR=/tmp npm run memory:auto-repair -- --dry-run --json
TMPDIR=/tmp npm run memory:embedding-calibrate
TMPDIR=/tmp npm run memory:generate-local-embeddings -- --help
```

## Reranker

Reranker 属于增强组件。它可以提升排序质量，但不应作为最小可用链路的硬依赖。

常见使用场景：

- 多个候选记忆相似时重新排序。
- 混合 lexical / vector / graph recall 后合并排序。
- enhanced/full profile 下提升复杂问题召回质量。

启用 Reranker 需要两层开关：先启动 adapter/upstream，再让 wrapper 调用 model reranker。

```bash
MEMORY_XX_RERANKER_ADAPTER_ENABLED=1
MEMORY_XX_RERANKER_UPSTREAM_ENABLED=1
MEMORY_XX_RERANKER_MODE=model
MEMORY_XX_RERANKER_ENDPOINT=http://127.0.0.1:8085/rerank
MEMORY_XX_RERANKER_MODEL=qwen3-reranker
```

如果 `MEMORY_XX_RERANKER_MODE=model` 或 `MEMORY_XX_RERANKER_ENDPOINT` 未配置，
wrapper 会继续使用本地排序融合；这属于正常降级，不应影响 Core write/recall。

## Fastpath 与 Mem0 激活关系

Enhanced/full sidecar 的 `MEMORY_XX_*_ENABLED=1` 只表示该模块进入运行计划或
服务启动条件，不等于 wrapper 已经把流量切过去。需要额外设置 wrapper 侧激活变量：

```bash
# Fastpath recall
MEMORY_XX_FASTPATH_ENABLED=1
MEMORY_XX_RECALL_PRIMARY=fastpath

# Mem0-style extraction
MEMORY_XX_MEM0_EXTRACTOR_ENABLED=1
MEMORY_XX_LLM_UPSTREAM_ENABLED=1
MEMORY_INTELLIGENCE_PROVIDER=mem0
MEMORY_INTELLIGENCE_MEM0_URL=http://127.0.0.1:5220
```

未设置 `MEMORY_XX_RECALL_PRIMARY=fastpath` 时，recall 仍走 Node wrapper 路径。
未设置 `MEMORY_INTELLIGENCE_PROVIDER=mem0` 时，即使
`MEMORY_INTELLIGENCE_MEM0_URL` 有默认值，intelligence 也仍使用 native provider。
