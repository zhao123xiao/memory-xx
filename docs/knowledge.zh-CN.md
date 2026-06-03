# Knowledge 文档治理

memory-xx 区分短事实 memory 和长文档 knowledge。

## Memory vs Knowledge

- **memory**：保存稳定偏好、项目约束、当前状态、决策、短事实。
- **knowledge**：保存教程、报告、runbook、架构说明、项目文档等长文本。
- **test/evidence**：保存训练或验证证据，不进入真实默认召回。

## Markdown 整理流程

Markdown 整理流程用于避免旧报告、重复计划、过期结论污染召回：

```bash
TMPDIR=/tmp npm run memory:knowledge-md -- scan --dry-run --json
TMPDIR=/tmp npm run memory:knowledge-md -- classify --dry-run --json
TMPDIR=/tmp npm run memory:knowledge-md -- ingest --dry-run --json
```

默认原则：

- 当前有效的 runbook、配置方式、项目事实可以进入 knowledge。
- 已解决、已过期、被后续报告覆盖的文档只归档或跳过。
- 长文不应直接写成 default memory；memory 中只保留短摘要或指针。

## 验证

```bash
TMPDIR=/tmp npm run test:knowledge-e2e
TMPDIR=/tmp npm run test:knowledge-hybrid
```
