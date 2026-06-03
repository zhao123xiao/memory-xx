# 架构说明

memory-xx 的核心原则是：PostgreSQL 是事实账本，Qdrant 是 active recall 投影，Policy Engine 决定写入去向，控制面板和 gate 负责运行治理。

## 数据流

```text
Conversation Sources / API / MCP
        |
        v
Conversation Events / Write Request
        |
        v
Extraction + Policy Engine
        |
        +--> reject / quarantine / pending
        |
        +--> approved memory record
                    |
                    v
            PostgreSQL truth ledger
                    |
                    +--> Temporal governance / graph evidence
                    |
                    v
         Embedding model / generation
                    |
                    v
              Qdrant projection
                    |
                    +--> Memory knowledge graph
                    |
                    +--> Code graph snapshots
                    |
                    v
          Recall candidates + optional reranker
                    |
                    v
             Agent tools / API / Control Panel
```

## 主要目录

- `app/`：服务核心代码，包括 DB、recall、governance、conversation、knowledge、server、Qdrant sync。
- `app/code-graph.ts`：轻量 code graph 构建器，负责文件、符号、导入、声明和调用关系建模。
- `scripts/`：CLI、worker、测试、观测、治理和部署辅助命令。
- `migrations/`：PostgreSQL schema migrations。
- `configs/`：公开配置模板。
- `systemd/`：Linux user service/timer 模板。
- `docs/`：API、架构、运维、runtime profile、rollback runbook。
- `tests/`：单元测试、集成测试和治理回归测试。

## 数据边界

- **memory**：短事实、偏好、项目约束、当前状态、决策。
- **knowledge**：长文档、教程、报告、runbook、项目知识。
- **pending**：等待人工或 policy sweep 决策的候选记忆。
- **event / audit**：运行证据、治理记录、feedback、rollback 信息。

## Recall 边界

- 只有 current、approved、`recall_policy=default` 的记忆进入默认 Qdrant recall。
- `explicit_only`、`test_only`、`audit_only`、`never` 不进入默认召回。
- archived、superseded、tombstone 记录保留在 PostgreSQL 历史账本，不保留 active Qdrant 点。
- test/eval scope 只能用于训练和验证，不应进入真实生产召回。
