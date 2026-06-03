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

## systemd 与平台部署

`systemd/` 下提供 wrapper、projector、maintenance、canary、landing scan、fastpath、lexical sidecar、embedding upstream、embedding proxy、reranker upstream、reranker adapter 等 user service/timer 模板。

```bash
mkdir -p ~/.config/systemd/user
cp systemd/memory-xx-qdrant-projector-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now memory-xx-qdrant-projector-worker.service
```

Windows / WSL / GPU 模型服务属于可选部署形态。公开用户需要按自己的环境配置 embedding upstream、reranker upstream、OpenVINO/OVMS 或其他 OpenAI-compatible endpoint。

```bash
TMPDIR=/tmp npm run memory:platform-doctor -- --json
TMPDIR=/tmp npm run memory:doctor -- --json
```

如果当前 shell 无法访问 `systemd --user` bus，timer probe warning 不一定代表 memory-xx 主链路不可用。
