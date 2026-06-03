# Policy Governance 与自动审批

memory-xx 的写入治理不是“抽取后直接入库”。默认链路是：

```text
conversation/API write
  -> extraction
  -> policy classification
  -> reject / quarantine / pending / approve
  -> review lifecycle
  -> PostgreSQL truth ledger
  -> Qdrant projection
```

## Policy Engine 拒绝类别

Policy Engine 会优先处理不应进入长期记忆的内容，例如：

- 明确“不需要记住”的 explicit no-memory
- secret、PII、敏感配置、token、key
- unknown source 或 source missing
- config dump、工具输出、测试噪音、hook/canary/perf 噪音
- runtime summary、cron promotion、短期运行摘要
- assistant-only continuation marker 或缺少事实状态的过程性文本

## 自动审批条件

自动审批依赖多重条件：

- trusted agent
- scope grant
- quality score
- policy action
- recall policy
- health gate
- candidate-only 状态
- production guard

`candidate_only` 是全局 kill switch；scope-level bypass 只能在明确授权范围内使用。

## 高风险能力

公开预览版不建议默认开启：

- global 自动写入
- real update/supersede/apply
- PII 自动批准
- candidate-only global bypass

## 常用命令

```bash
TMPDIR=/tmp npm run memory:auto-approval -- status --json
TMPDIR=/tmp npm run memory:auto-approval -- production-guard --json
TMPDIR=/tmp npm run memory:auto-approval-sweep -- --dry-run --json
TMPDIR=/tmp npm run memory:auto-approval-limit-advisor -- --json
TMPDIR=/tmp npm run memory:auto-approval-ops -- --json
TMPDIR=/tmp npm run memory:policy-report -- --json
```

## 记忆更新与 Supersede

memory-xx 不只支持新增记忆，也支持记忆更新生命周期：

- `update-candidate`：为已有记忆生成候选更新，不直接覆盖事实账本。
- `supersede`：用新事实替代旧事实，旧记录进入历史链路。
- `archive`：把不再有效的记录移出 current recall。
- `tombstone`：对不应继续使用的记录做强失效。
- rollback：对错误批准或错误更新做回滚。

真实生产的 update/supersede/apply 是高风险能力。默认建议先 test scope 验证，再 project dry-run，再小范围 canary。

```bash
TMPDIR=/tmp npm run memory:auto-update -- --dry-run --json
TMPDIR=/tmp npm run memory:review -- --json
TMPDIR=/tmp npm run memory:archive -- <memory_id>
TMPDIR=/tmp npm run test:auto-update-corpus
TMPDIR=/tmp npm run test:auto-update-rollback-e2e
```
