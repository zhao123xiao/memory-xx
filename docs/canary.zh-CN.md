# Canary 与生产就绪

memory-xx 的生产开放不应只依赖离线 benchmark。推荐通过 canary 积累真实反馈，再判断是否扩大权限。

## 报告类型

- `memory:landing-scan`：采集 runtime、pending、Qdrant、P1、policy、conversation source、production guard 等快照。
- `memory:canary-7d-report`：聚合最近 7 天 landing scan，判断连续健康天数和 candidate-only 退出阻塞原因。
- `memory:pending-canary-report`：把 pending 作为 canary 反馈样本，用于完善 policy 和 auto-approval 规则。
- `memory:p0-gate` / `memory:p1-gate`：发布前门禁。

## candidate-only 退出条件

candidate-only 退出至少需要满足：

- 真实反馈样本足够
- pending 不失控
- Qdrant drift 为 0
- P1 gate 通过
- production guard 通过
- default recall leakage 为 0
- unknown/sensitive/test-noise auto approve 为 0
- rollback rate 可解释

## 命令

```bash
TMPDIR=/tmp npm run memory:landing-scan -- --json --write-report
TMPDIR=/tmp npm run memory:canary-7d-report -- --json --write-report
TMPDIR=/tmp npm run memory:pending-canary-report -- --json
TMPDIR=/tmp npm run memory:p0-gate
TMPDIR=/tmp npm run memory:p1-gate
```

默认 7 天 canary 只要求通用的 `codex_session` 和 `claude_code_session` 具备 E2E 证据。OpenClaw 属于可选会话来源；如果你的部署确实要求 OpenClaw 也参与生产门禁，可以显式指定：

```bash
TMPDIR=/tmp npm run memory:canary-7d-report -- --json --write-report --required-source=openclaw_session
```

公开预览版不建议默认开启 global 自动写入，也不建议默认开启 real update/supersede/apply。
