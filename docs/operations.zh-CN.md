# 运维与恢复

本文覆盖 worker、systemd、backup、migration、doctor、canary 和平台部署。

## 异步 Worker

memory-xx 通过 outbox 和 worker 把主写入账本与投影、缓存、异步处理解耦。

主要 worker：

- Qdrant projector worker：消费 outbox，把 approved/default/current 记忆投影到 Qdrant。
- write ticket worker：处理异步写入票据。
- conversation monitor worker：扫描 conversation events 和真实 session source。
- cache invalidation worker：处理写入后召回缓存失效。

常用命令：

```bash
TMPDIR=/tmp npm run run:qdrant-projector-worker
TMPDIR=/tmp npm run run:write-ticket-worker
TMPDIR=/tmp npm run run:conversation-monitor-worker
TMPDIR=/tmp npm run run:cache-invalidation-worker
```

## 恢复机制

```bash
TMPDIR=/tmp npm run memory:outbox-recovery -- --json
TMPDIR=/tmp npm run memory:dlq-recovery -- --json
TMPDIR=/tmp npm run replay:qdrant-outbox
TMPDIR=/tmp npm run memory:auto-repair -- --dry-run --json
```

## Backup / Migration / Rollback

相关 runbook：

- `docs/runbooks/backup-restore.md`
- `docs/runbooks/migration-rollback.md`
- `docs/migration-rollback-playbook.md`

常用命令：

```bash
TMPDIR=/tmp npm run memory:backup -- --dry-run
TMPDIR=/tmp npm run migrate
TMPDIR=/tmp npm run check:migrations
TMPDIR=/tmp npm run check:db-invariants
TMPDIR=/tmp npm run memory:migration-preflight -- --json
TMPDIR=/tmp npm run memory:deployment-bundle -- --help
```

生产迁移前应先在 shadow schema 或测试数据库验证，不要直接对真实账本做不可逆变更。

## Canary 与生产就绪门禁

```bash
TMPDIR=/tmp npm run memory:landing-scan -- --json --write-report
TMPDIR=/tmp npm run memory:canary-7d-report -- --json --write-report
TMPDIR=/tmp npm run memory:pending-canary-report -- --json
TMPDIR=/tmp npm run memory:p0-gate
TMPDIR=/tmp npm run memory:p1-gate
```

candidate-only 退出至少需要满足：真实反馈样本足够、pending 不失控、Qdrant drift 为 0、P1 gate 通过、production guard 通过、default recall leakage 为 0、unknown/sensitive/test-noise auto approve 为 0、rollback rate 可解释。

公开分层验收可以按模块单独运行。`L1` 覆盖单元和 HTTP contract，`L19` 覆盖 conversation monitor 从 JSONL spool 到 recall 的链路。cache invalidation、write ticket、markdown projection、memory dreaming、full ops、policy ops、knowledge graph、Qdrant reconciliation、recall quality、temporal ops、backup ops、runtime observability 和 trusted agent smoke 会用 live PostgreSQL、Redis、Qdrant、配置好的 embedding provider、生成的投影文件、安全降级的 dream cycle、治理报告、增强 graph 模块、投影修复状态、recall/reranker 质量面、temporal governance、backup dry-run、deployment packaging report、retention report 与 trusted-agent audit 验证持久化后台 worker 与可插拔能力。`smoke:knowledge-graph` 只执行 Knowledge Markdown scan、graph health/report 和 repository code graph，不会 ingest 或 archive 文档。`smoke:qdrant-reconciliation` 只运行 report/status surface，不会 replay outbox、mark dispatched 或 apply Qdrant repair。`smoke:recall-quality` 只运行 trace replay quality、intelligence compare status、trace feedback candidates 和 reranker policy benchmark，不会写 observations、apply feedback 或执行 repair。`smoke:temporal-ops` 只运行 decay、expiry sweep、temporal policy 和 consolidation dry-run；consolidation 会 rollback transaction，不会提交 archive、episode、entity 或 relation 写入。`smoke:backup-ops` 只运行 backup plan、migration preflight、临时目录 deployment bundle 和 secrets audit 报告；不会创建数据库 dump，也不会复制 live secrets。backup plan 是 admin 操作，运行前需要设置 `MEMORY_XX_CLI_TOKEN` 或 `MEMORY_XX_ADMIN_TOKEN`。`smoke:runtime-observability` 只运行 runtime retention、recall trace retention 和 runtime artifact cleanup dry-run/report；不会删除 trace、prune observability rows，也不会移动 residue logs。`smoke:trusted-agent` 只运行 trusted-agent 与 scope-grant audit/list surface；不会注册、撤销或修改 token：

```bash
TMPDIR=/tmp npm run test:unit-contract
TMPDIR=/tmp npm run test:conversation-monitor
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
```

`L7` 覆盖可选 OpenClaw adapter。公开 harness 默认不把它作为阻塞层，避免没有 OpenClaw 的部署无法验证 Core、enhanced 和 full 模块。只有目标环境明确要求 OpenClaw 时才显式开启：

```bash
TMPDIR=/tmp node --import tsx scripts/test-harness/reports/aggregator.ts --layer=L7 --require-openclaw
MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION=1 TMPDIR=/tmp node --import tsx scripts/test-harness/reports/aggregator.ts --layer=L7
```

## systemd 与平台部署

`systemd/` 下提供 wrapper、projector、maintenance、canary、landing scan、fastpath、lexical sidecar、embedding upstream、embedding proxy、reranker upstream、reranker adapter、mem0 extractor、conversation monitor、control panel 等 user service/timer 模板。

`memory-xx.target` 默认只拉起 Core 在线链路：wrapper、Qdrant projector worker 和 embedding proxy。fastpath、lexical sidecar、reranker、Mem0 extractor、conversation monitor、control panel 等模块需要按环境显式开启，避免公开用户缺少本地模型或 LLM endpoint 时影响 Core 运行。需要 systemd 服务组时可以启用 `memory-xx-enhanced.target` 或 `memory-xx-full.target`，各 unit 仍会通过 `MEMORY_XX_*_ENABLED` 开关安全退出或降级。

```bash
mkdir -p ~/.config/systemd/user
cp systemd/memory-xx*.service systemd/memory-xx*.timer systemd/memory-xx*.target ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now memory-xx.target
TMPDIR=/tmp npm run memory:up -- --mode enhanced
```

Windows / WSL / GPU 模型服务属于可选部署形态。公开用户需要按自己的环境配置 embedding upstream、reranker upstream、OpenVINO/OVMS 或其他 OpenAI-compatible endpoint。

```bash
TMPDIR=/tmp npm run memory:platform-doctor -- --json
TMPDIR=/tmp npm run memory:doctor -- --json
```

如果当前 shell 无法访问 `systemd --user` bus，timer probe warning 不一定代表 memory-xx 主链路不可用。

Docker Compose 的增强/full 启动需要同步设置 wrapper runtime profile，否则 sidecar 已启动但 `/health`、Doctor 和控制面板仍会按 Core 口径解释模块状态：

```bash
MEMORY_XX_RUNTIME_PROFILE=enhanced docker-compose --profile enhanced up --build -d
MEMORY_XX_RUNTIME_PROFILE=full docker-compose --profile full up --build -d
```

`full` 会包含 enhanced 服务，并再启动 Mem0 extractor、conversation monitor、cache invalidation worker、maintenance、consolidation、detect、auto-repair、repair report、landing scan、canary report 等 full 模块。这些模块仍受各自 `MEMORY_XX_*_ENABLED=0` 开关控制，未启用时应安全退出或保持降级状态。
