# memory-xx

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="node">
</p>

memory-xx 是一套面向本地 AI Agent 和多 Agent 系统的长期记忆框架。它不是简单的"把对话存进向量库"，而是一套从写入策略、召回质量、生命周期治理到运行可观测性的完整记忆基础设施。

PostgreSQL 是唯一事实账本，Qdrant 是向量召回投影，Redis 负责缓存和分布式协同。通过 HTTP REST API 和 MCP 协议对外暴露 write、recall、review、agent token、治理和运行状态能力。

v0.1.0 public preview，MIT 协议开源。

## 定位

memory-xx 不是一键部署的 SaaS 产品，也不是面向零基础用户的工具。它假设你：

- 熟悉命令行和 Linux/Windows 服务器基本操作
- 能够自行安装和管理 PostgreSQL、Redis、Qdrant
- 理解 embedding 模型和向量检索的基本概念
- 愿意投入时间配置和调优

如果你满足这些条件，memory-xx 提供的是目前开源社区中最完整的本地 Agent 长期记忆方案之一。

## 为什么需要 memory-xx

普通的 RAG 或向量数据库只解决"存文本 + 相似搜索"。当你真正把 AI Agent 作为日常工作的长期伙伴时，会遇到一系列向量库解决不了的问题：

**写入策略**：Agent 对话里哪些信息值得长期记住？哪些是噪音？哪些涉及隐私不应该记录？哪些需要人工确认后才能写入？memory-xx 的 Policy Engine 在写入链路的最前端做出判断——拒绝、隔离、等待审批，还是直接写入。

**生命周期治理**：记忆不是一成不变的。用户的偏好会改变，事实会过时，旧信息应该被新信息替换。memory-xx 提供 approve -> reject -> archive -> supersede -> tombstone 的完整生命周期状态机，每条记忆都有清晰的来龙去脉。

**多 Agent 共享与隔离**：你可能同时使用 Codex、Claude Code、OpenClaw 等多个 Agent。它们应该共享某些记忆（比如你的技术偏好），但又有各自的私有记忆空间。memory-xx 的 scope 模型（user / project / workspace / global）在共享和隔离之间划出清晰的边界。

**召回质量**：简单的向量相似搜索往往不够。memory-xx 的 recall 链路是 hybrid retrieval——同时执行向量检索（Qdrant）、全文检索（lexical sidecar）和图谱检索（knowledge graph），经过 RRF 融合和可选的 reranker 重排序，最后通过 confidence gate 过滤低质量结果。

**降级容错**：reranker 挂了、fastpath 不可用、Mem0 extractor 没启动——这些都不应该让整个记忆系统瘫痪。memory-xx 的三级 profile（Core / Enhanced / Full）设计保证了增强模块不可用时自动回退到 Core 路径，write 和 recall 始终可用。

**运行可观测性**：embedding 生成是否正常？Qdrant 投影是否与 PostgreSQL 一致？待审批记忆积压了多少？召回质量趋势如何？memory-xx 提供 health endpoint、control panel、doctor、landing scan、canary report 等完整的可观测性工具链。
## 架构

```
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
       hybrid recall (vector + lexical + graph)
                 |
                 +--> RRF fusion
                 +--> optional reranker
                 |
                 v
        Agent tools / HTTP API / Control Panel
```

核心原则只有一条：**PostgreSQL 是唯一事实源**。Qdrant 和 Markdown projection 都是只读投影，任何时候都可以从 PostgreSQL 重建。Policy Engine 在写入链路最前端决定记忆的去向。增强模块不可用时自动降级到 Core 路径，write 和 recall 不中断。

## 模型依赖

memory-xx 依赖三类 AI 模型。下面给出每种模型的作用、是否必需、以及推荐的本地部署方案。

### Embedding 模型（必需）

作用：将记忆内容和查询文本转换为向量，是写入和召回的基础。

没有 embedding 模型，memory-xx 无法工作。你可以选择：

| 方案 | 适用场景 | 说明 |
| --- | --- | --- |
| 远程 API | 有 API 预算，不想本地部署模型 | 任何 OpenAI-compatible embedding API 均可，如 OpenAI、硅基流动、阿里百炼等 |
| 本地部署 | 隐私优先，或没有稳定网络 | 使用 OVMS（OpenVINO Model Server）或 vLLM 等推理框架部署 |

**推荐本地模型**：`Qwen3-Embedding-0.6B`。4096 维输出，纯 CPU 可运行，内存占用约 1.5GB。对于个人 Agent 的日常记忆场景，语义质量完全够用。

如果你有 GPU，可以升级到 `Qwen3-Embedding-4B` 或 `Qwen3-Embedding-8B` 获得更好的语义表示。

embedding 模型通过 embedding proxy（端口 5221）接入 memory-xx，proxy 负责限流、重试、去重和响应缓存。配置方式：

```bash
# 远程 API
EMBEDDING_API_BASE=https://your-provider/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMS=1536
OPENAI_API_KEY=sk-...

# 本地 OVMS
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=Qwen3-Embedding-0.6B
EMBEDDING_DIMS=4096
```

### Reranker 模型（可选但强烈推荐）

作用：对召回候选结果重排序，大幅提升召回精度。

没有 reranker 时，memory-xx 使用 RRF（Reciprocal Rank Fusion）融合多路召回结果。RRF 是纯算法排序，不依赖模型，但精度有限。加上 reranker 后，候选记忆会经过 Cross-Encoder 模型逐对打分，Top-5 精度通常有 30-50% 的提升。

**推荐本地模型**：`Qwen3-Reranker-0.6B`。与 embedding 模型同系列，纯 CPU 可运行，内存占用约 1.5GB。

reranker 通过 reranker adapter（端口 8085）接入，adapter 负责协议转换和超时控制：

```bash
MEMORY_XX_RERANKER_ADAPTER_URL=http://127.0.0.1:8085
MEMORY_XX_RERANKER_DOWNSTREAM_URL=http://127.0.0.1:8084/v3/rerank
MEMORY_XX_RERANKER_ENABLED=1
```

### LLM 模型（Mem0 extractor 需要）

作用：从 Agent 对话中智能提取结构化记忆。

memory-xx 的 Core 链路不依赖 LLM——你可以通过 API 直接写入结构化的记忆内容。但如果希望系统自动从 Codex、Claude Code 等 Agent 的对话历史中提取长期记忆，就需要 Mem0 extractor（端口 5220），它内部使用 LLM 做语义抽取。

**推荐方案**：

| 方案 | 适用场景 | 说明 |
| --- | --- | --- |
| 远程 API | 已有 OpenAI/兼容 API 的额度 | 最简单，配置 `MEMORY_XX_MEM0_BASE_URL` 和 `MEMORY_XX_MEM0_API_KEY` 即可 |
| 本地部署 | 隐私优先，对话量大 | 部署 Qwen3-8B 或更小的 Instruct 模型，通过 OVMS 或 vLLM 暴露 OpenAI-compatible endpoint |

```bash
# 远程 API
MEMORY_XX_MEM0_BASE_URL=https://api.openai.com/v1
MEMORY_XX_MEM0_MODEL=gpt-4o-mini
MEMORY_XX_MEM0_API_KEY=sk-...

# 本地模型
MEMORY_XX_MEM0_BASE_URL=http://127.0.0.1:8080/v1
MEMORY_XX_MEM0_MODEL=Qwen3-8B
```

如果不启用 Mem0 extractor，你仍然可以通过 API 手动写入记忆，或使用内置的轻量抽取策略（不需要 LLM）。

### 纯 CPU 方案总结

如果你只有 CPU，以下是推荐的模型组合：

| 组件 | 推荐模型 | 内存占用 | 必需 |
| --- | --- | --- | --- |
| Embedding | Qwen3-Embedding-0.6B | ~1.5 GB | 是 |
| Reranker | Qwen3-Reranker-0.6B | ~1.5 GB | 强烈推荐 |
| LLM (Mem0) | Qwen3-8B (或远程 API) | ~16 GB (本地) | 仅自动提取需要 |

总计：纯 CPU 本地部署 embedding + reranker 约需 3GB 内存。如果再加上本地 LLM，建议 32GB 以上内存。如果使用远程 LLM API，16GB 内存即可运行完整链路。
## 三级运行 Profile

memory-xx 按 `MEMORY_XX_RUNTIME_PROFILE` 环境变量分为三级。这不是三个不同的版本，而是同一套代码的三种运行模式——模块按环境变量热插拔，关闭或降级时不影响 Core write/recall。

### Core — 最小可运行链路

这是 memory-xx 的骨架。只要 Core 能跑，记忆系统就能用。

| 组件 | 端口 | 说明 |
| --- | --- | --- |
| HTTP / MCP wrapper | 5100 | API 入口，所有请求的网关 |
| PostgreSQL truth ledger | 5432 | 结构化存储、生命周期状态机、事件溯源、outbox |
| Redis cache / coordination | 6379 | 查询 embedding 缓存、分布式锁、任务队列 |
| Qdrant active projection | 6333 | 向量召回投影，只包含 approved/current 记忆 |
| embedding proxy | 5221 | 统一 embedding 接口，限流、重试、去重、缓存 |
| Qdrant projector worker | - | 消费 Postgres outbox，同步投影到 Qdrant |

Core 完成的核心链路：**写入 -> Policy Engine 判断 -> PostgreSQL 事实账本 -> outbox 事件 -> embedding 生成 -> Qdrant 投影 -> hybrid recall -> 返回结果**。

### Enhanced — 更好的召回质量和接入体验

在 Core 基础上叠加增强模块，每个模块可以独立开关：

| 组件 | 端口 | 说明 |
| --- | --- | --- |
| fastpath recall | 5200 | Go 实现的高性能召回路径，降低召回延迟 |
| lexical sidecar | 5210 | Rust 实现的全文检索，补齐向量检索的词汇匹配盲区 |
| Qdrant proxy | 6334 | Qdrant 连接池代理，减少连接开销 |
| reranker adapter | 8085 | Cross-Encoder 重排序适配器，提升召回精度 |
| Mem0 extractor | 5220 | 基于 LLM 的智能记忆抽取 |
| conversation monitor | - | 自动扫描 Agent 会话目录，发现新的可提取对话 |
| control panel | 5310 | 本地 Web 运维界面（建议只绑定 127.0.0.1） |
| platform doctor | - | 平台健康检查，诊断依赖服务状态 |

Enhanced 模块不可用时，系统自动回退到 Core 路径——reranker 挂了就用 RRF 排序，fastpath 挂了就走 wrapper 直接召回。

### Full — 完整治理和生产化运行

Full 面向长期运行，包含后台运维、审计和质量保障能力：

| 能力 | 说明 |
| --- | --- |
| Knowledge ingest | 文档知识库导入和混合检索（独立 Qdrant collection） |
| Memory knowledge graph | 基于 episodes、entities、relations 的记忆图谱 |
| Code Graph | 扫描代码仓库，生成文件/符号/依赖/调用关系图谱 |
| temporal decay / consolidation | 记忆强度衰减计算、重复记忆去重、episode 构建 |
| memory dreaming | 自主一致性审计和自动修复 |
| policy evaluation | 自动审批策略评估和执行 |
| recall quality | 召回质量评估报告 |
| auto approval / auto update | 自动审批和自动更新运维 |
| embedding manifest / calibration | embedding 代际管理和校准 |
| backup and restore | 备份和恢复计划 |
| Qdrant reconciliation | Postgres 与 Qdrant 一致性对账和修复 |
| governance operations | 治理运维：冻结、回滚、债务追踪、容量审计 |
| runtime observability | 运行指标采集和保留 |
| self-improvement ops | 自我改进运维 |

Full 能力默认不开启。需要某个模块时，先配置对应的 `MEMORY_XX_*_ENABLED=1` 开关，再通过 health、doctor 或 operations 文档确认状态。
## 快速开始

### 环境要求

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | 20+ | 运行时 |
| PostgreSQL | 16 | 建议使用 pgvector/pgvector:pg16 镜像 |
| Redis | 7+ | 缓存和协同 |
| Qdrant | 最新稳定版 | 向量检索引擎 |
| Embedding 模型 | OpenAI-compatible | 必需，见上文模型依赖章节 |

WSL 用户注意：运行 npm/tsx 命令时加 `TMPDIR=/tmp`，避免 tsx Unix socket 放在 Windows 文件系统导致异常。

### 安装和配置

```bash
# 克隆仓库
git clone https://github.com/zhao123xiao/memory-xx.git
cd memory-xx

# 安装依赖
npm install

# 复制配置模板
cp configs/memory-xx.env.example .env
```

编辑 `.env`，至少配置以下变量：

```bash
# 数据库
MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/memory_xx
MEMORY_XX_DATABASE_SCHEMA=memory_xx

# 缓存
MEMORY_XX_REDIS_URL=redis://127.0.0.1:6379/0

# 向量检索引擎
MEMORY_XX_QDRANT_BASE_URL=http://127.0.0.1:6333
MEMORY_XX_QDRANT_COLLECTION=memory_xx

# Embedding 模型（必需）
EMBEDDING_API_BASE=http://127.0.0.1:5221/v1
EMBEDDING_MODEL=Qwen3-Embedding-0.6B
EMBEDDING_DIMS=4096

# API 鉴权
MEMORY_XX_API_TOKEN=your-secret-token-here
OPENAI_API_KEY=your-embedding-api-key
```

### 启动

```bash
# 加载环境变量
set -a && . ./.env && set +a

# 运行数据库迁移
TMPDIR=/tmp npm run migrate

# 启动服务
TMPDIR=/tmp npm start
```

### 验证

```bash
# 存活检查
curl http://127.0.0.1:5100/live

# 健康检查
curl -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  http://127.0.0.1:5100/health

# 运行状态
TMPDIR=/tmp npm run memory:status -- --json
```

Docker Compose 一键启动见 [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md)。
## API 概览

所有 API 路径前缀为 `/api/memory/xx`，鉴权通过 `Authorization: Bearer <token>` 头。

### 写入记忆

```bash
curl -X POST "http://127.0.0.1:5100/api/memory/xx/write" \
  -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "用户偏好：默认使用中文回复技术问题",
    "scope_type": "user",
    "scope_id": "local-user",
    "metadata": { "source": "manual" }
  }'
```

### 召回记忆

```bash
curl -X POST "http://127.0.0.1:5100/api/memory/xx/recall/query" \
  -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "用户偏好什么语言回复？",
    "scope": { "user_id": "local-user" },
    "limit": 5
  }'
```

### 审批记忆

```bash
# 查看待审批列表
curl -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  "http://127.0.0.1:5100/api/memory/xx/review/pending?limit=20"

# 批准
curl -X POST "http://127.0.0.1:5100/api/memory/xx/review/memories/{memory_id}/approve" \
  -H "Authorization: Bearer $MEMORY_XX_API_TOKEN"

# 拒绝
curl -X POST "http://127.0.0.1:5100/api/memory/xx/review/memories/{memory_id}/reject" \
  -H "Authorization: Bearer $MEMORY_XX_API_TOKEN"
```

### 智能写入（需要 Mem0 extractor）

```bash
curl -X POST "http://127.0.0.1:5100/api/memory/xx/write/smart" \
  -H "Authorization: Bearer $MEMORY_XX_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "我今天把项目的数据库从 MySQL 迁移到了 PostgreSQL 16，主要原因是需要 pgvector 扩展来支持向量检索。",
    "scope_type": "project",
    "scope_id": "my-project"
  }'
```

### Scope 说明

Strict scope 默认开启。如果 scoped 操作返回 403，使用 trusted agent token 或 admin token。本地调试可临时设置 `MEMORY_XX_SCOPE_POLICY_MODE=single_user` 绕过 scope 检查。

完整 API 参考见 [docs/api.md](docs/api.md)。
## Agent 会话接入

memory-xx 可以自动读取 Codex、Claude Code 或 OpenClaw 的历史会话目录，通过 conversation monitor 和 Mem0 extractor 自动提取长期记忆。

```bash
# 配置会话目录（替换 <user> 为实际用户名）
MEMORY_XX_CODEX_SESSION_ROOTS=/home/<user>/.codex/sessions
MEMORY_XX_CLAUDE_SESSION_ROOTS=/home/<user>/.claude/projects
MEMORY_XX_OPENCLAW_SESSION_ROOTS=/home/<user>/.openclaw/agents/main/sessions
```

OpenClaw 是可选 adapter。landing scan 和 canary 默认只要求 Codex 和 Claude Code source，显式传入 `--required-source=openclaw_session` 才纳入 OpenClaw。

### MCP 接入

memory-xx 内置 MCP server，支持 stdio 和 HTTP 两种 transport。Agent 可以通过 MCP 协议直接调用 memory-xx 的 tools：

- `memory_xx_write` — 写入记忆
- `memory_xx_recall` — 召回记忆
- `memory_xx_smart_write` — 智能提取并写入
- `memory_xx_pending` — 查看待审批记忆
- `memory_xx_approve` / `memory_xx_reject` — 审批记忆
- `memory_xx_feedback` — 提交召回反馈
- `memory_xx_summarize` — 记忆摘要
- `memory_xx_forget` — 遗忘记忆

MCP 客户端建议使用独立的 `MEMORY_XX_MCP_TOKEN`，绑定 trusted agent 和 scope grants。详见 [docs/agent-integration.zh-CN.md](docs/agent-integration.zh-CN.md)。

## 项目结构

```
memory-xx/
├── app/                         # 服务源码（TypeScript strict mode）
│   ├── api/                     # HTTP handlers（unified、intelligence、knowledge、skills）
│   ├── cache/                   # Redis 缓存层（查询缓存、召回缓存）
│   ├── consolidation/           # 去重、冲突解决、episode 构建
│   ├── coordination/            # 分布式协调（outbox dispatcher、锁、DLQ、任务队列）
│   ├── db/                      # PostgreSQL schema、adapter、transaction、migration
│   ├── decay/                   # 记忆强度衰减计算、自动归档
│   ├── dream/                   # 自主维护 worker（一致性审计、自动修复）
│   ├── embedding/               # embedding 生成清单、健康检查、校准
│   ├── governance/              # 治理引擎（自动审批策略、测试污染评分、隐私扫描）
│   ├── intelligence/            # LLM 智能抽取（intent guard、冲突消解、去重、质量门）
│   ├── knowledge/               # 知识库搜索（独立 Qdrant collection）
│   ├── mcp/                     # MCP 协议实现、tool registry、transport
│   ├── observability/           # 领域指标、Qdrant 健康、post-commit 降级检测
│   ├── ops/                     # 运维工具（preflight、cutover、gates、rollback）
│   ├── orchestrator/            # 统一编排入口
│   ├── projection/              # Markdown 投影导出（只读，不从 Markdown 反向同步）
│   ├── qdrant-sync/             # Postgres outbox -> Qdrant 投影同步管线
│   ├── recall/                  # 检索编排（hybrid planner、RRF fusion、reranker、confidence gate）
│   ├── review/                  # 审批服务（approve/reject/archive/supersede/tombstone）
│   ├── server/                  # HTTP server、auth、rate limiter、metrics、CORS、permissions
│   ├── shared/                  # 类型定义、常量、contracts、logger、circuit breaker
│   ├── skills/                  # 技能注册（deep-search、health-check、smart-write 等）
│   └── write/                   # 写入服务（事务、幂等、outbox、projection sync）
├── configs/                     # 环境变量配置模板
├── deploy/                      # 部署模板
├── docs/                        # 文档（中英文）
├── migrations/                  # PostgreSQL 迁移 SQL
├── scripts/                     # CLI 脚本和运维工具
│   └── test-harness/            # L0-L19 分层测试框架
├── sidecars/                    # 增强 sidecar 独立实现
│   ├── embedding-proxy/         # embedding 代理（限流、重试、去重、缓存）
│   ├── fastpath/                # Go 高性能召回路径
│   ├── lexical-sidecar/         # Rust 全文检索
│   ├── mem0-extractor/          # Python Mem0 风格记忆抽取器
│   ├── qdrant-proxy/            # Qdrant 连接池代理
│   ├── reranker-adapter/        # 重排序适配器
│   ├── dev-embedding-upstream/  # 开发用确定性 embedding（仅 smoke 测试）
│   ├── dev-reranker-upstream/   # 开发用 reranker upstream
│   └── dev-chat-upstream/       # 开发用 LLM upstream
├── systemd/                     # systemd service 文件
└── tests/                       # 测试套件（121 个测试文件，L0-L19 分层 gate）
```
## 运行边界与注意事项

| 规则 | 说明 |
| --- | --- |
| Embedding 必需 | 无 embedding 模型则无法写入和召回，这是唯一的硬依赖 |
| Reranker 可选 | 增强召回质量，不可用时自动回退到 RRF 算法排序 |
| PostgreSQL 是唯一事实源 | Qdrant 和 Markdown projection 都是只读投影，可随时从 PostgreSQL 重建 |
| Redis 降级 | 不可用时缓存和协同能力降级，不影响事实存储 |
| 增强模块降级 | fastpath、lexical、reranker、Mem0 等不可用时自动回退 Core 路径 |
| Control Panel | 本地运维界面，默认绑定 127.0.0.1:5310，不要直接暴露公网 |
| Markdown projection | 只读导出投影，不支持从 Markdown 反向同步到 PostgreSQL |
| global scope 写入 | 默认不建议开启，避免不同项目/Agent 之间的记忆污染 |
| auto update / supersede | 默认不建议直接开启，应先 dry-run 或 canary 验证 |

## 常用运维命令

```bash
# 查看系统状态
TMPDIR=/tmp npm run memory:status -- --json

# 查看待审批记忆
TMPDIR=/tmp npm run memory:pending -- --limit=100

# Qdrant 一致性对账
TMPDIR=/tmp npm run memory:qdrant-reconcile -- --json

# 自动修复（先 dry-run）
TMPDIR=/tmp npm run memory:auto-repair -- --dry-run --json

# 召回质量报告
TMPDIR=/tmp npm run memory:quality

# 治理审计
TMPDIR=/tmp npm run memory:governance

# 记忆强度衰减和去重
TMPDIR=/tmp npm run memory:consolidate

# 备份
TMPDIR=/tmp npm run memory:backup -- --apply

# 平台健康检查
TMPDIR=/tmp npm run memory:doctor

# 密钥和安全扫描
npm run check:secrets

# 运行测试
npm test
npm run test:postgres
npm run test:gates
```

## 文档导航

| 想了解 | 文档 |
| --- | --- |
| 快速启动（含 Docker Compose） | [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md) |
| 完整功能清单和成熟度 | [docs/features.zh-CN.md](docs/features.zh-CN.md) |
| 架构和数据流 | [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) |
| Agent / MCP 接入 | [docs/agent-integration.zh-CN.md](docs/agent-integration.zh-CN.md) |
| Policy Engine、自动审批 | [docs/policy-governance.zh-CN.md](docs/policy-governance.zh-CN.md) |
| Embedding、Reranker、Qdrant | [docs/vector-runtime.zh-CN.md](docs/vector-runtime.zh-CN.md) |
| 控制面板和热插拔 | [docs/control-panel.zh-CN.md](docs/control-panel.zh-CN.md) |
| Worker、备份、迁移、systemd | [docs/operations.zh-CN.md](docs/operations.zh-CN.md) |
| Knowledge 文档治理 | [docs/knowledge.zh-CN.md](docs/knowledge.zh-CN.md) |
| Canary 与生产就绪 | [docs/canary.zh-CN.md](docs/canary.zh-CN.md) |
| API 参考 | [docs/api.md](docs/api.md) |
| Runtime profile | [docs/runtime-profiles.md](docs/runtime-profiles.md) |
| Module catalog | [docs/module-catalog.md](docs/module-catalog.md) |
| 开源发布检查清单 | [docs/release-checklist.md](docs/release-checklist.md) |
| Release notes | [CHANGELOG.md](CHANGELOG.md) |

## 许可证

MIT。见 [LICENSE](LICENSE)。
