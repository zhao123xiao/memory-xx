# memory-xx 功能成熟度

> 最后更新：2026-06-09

本文档详细说明 memory-xx 各功能的成熟度等级，帮助用户和开发者了解功能的可用性、稳定性和风险级别。

## 成熟度等级说明

| 等级 | 标识 | 说明 | 默认状态 | 使用建议 |
|------|------|------|----------|----------|
| **stable** | 🟢 稳定 | 默认可用，有测试和运行证据，失败时有降级或明确错误 | 启用 | 可直接在生产使用 |
| **beta** | 🟡 测试 | 可用但依赖阈值、guard、scope 或人工复核 | 禁用 | 团队内部试运行，需保留人工复核 |
| **experimental** | 🟠 实验 | 报告/候选/观察为主，不建议生产自动化依赖 | 禁用 | 用于观察和评估，不建议生产依赖 |
| **dangerous** | 🔴 高风险 | 会批量修改真实数据，必须先 dry-run 再 apply | 禁用 | 测试阶段，请谨慎使用；必须先 dry-run；确认备份和 rollback 方案后再 apply |

---

## 🟢 Stable（稳定）

### 核心操作

| 功能 | 入口 | 说明 |
|------|------|------|
| Memory Write | `memory:write` | 基础写入，Postgres 主账本，幂等性保证 |
| Memory Recall | `memory:recall` | 基础召回，Qdrant 向量后端，支持降级 |
| Memory Review | `memory:review` | 人工审批工作流 |
| Memory Approve | `memory:approve` | 人工批准记忆 |
| Memory Reject | `memory:reject` | 人工拒绝记忆 |
| Memory Archive | `memory:archive` | 人工归档记忆 |

### 状态与诊断

| 功能 | 入口 | 说明 |
|------|------|------|
| System Status | `memory:status` | 系统运行状态，支持 Postgres、Redis、Qdrant |
| System Doctor | `memory:doctor` | 健康诊断检查 |
| Platform Doctor | `memory:platform-doctor` | 平台级健康检查 |

### 运行模式

| 功能 | 入口 | 说明 |
|------|------|------|
| Runtime Mode | `memory:mode` | core/enhanced/full 配置档 |
| Runtime Up | `memory:up` | 启用运行时 |
| Runtime Down | `memory:down` | 禁用运行时 |

### 待审批列表

| 功能 | 入口 | 说明 |
|------|------|------|
| Pending Candidates | `memory:pending` | 列出待审批记忆 |
| Pending Governance | `memory:pending-governance` | 列出待治理项目 |

### Qdrant（只读）

| 功能 | 入口 | 说明 |
|------|------|------|
| Qdrant Collection Audit | `memory:qdrant-collection-audit` | 集合审计（只读） |
| Qdrant Alias | `memory:qdrant-alias` | 集合别名管理 |

### 权限与安全

| 功能 | 入口 | 说明 |
|------|------|------|
| Trusted Agent | `memory:trusted-agent` | 基于 scope 的可信代理 |

### Embedding

| 功能 | 入口 | 说明 |
|------|------|------|
| Embedding Manifest | `memory:embedding-manifest` | 向量模型配置、维度、版本信息 |

### Outbox

| 功能 | 入口 | 说明 |
|------|------|------|
| Outbox Recovery | `memory:outbox-recovery` | 事件恢复检查（支持 dry-run） |

### 开源就绪

| 功能 | 入口 | 说明 |
|------|------|------|
| Open Source Verification | `verify:open-source` | 开源验证（secret scan, preaudit） |
| Open Source Preaudit | `open-source:preaudit` | 发布前检查 |
| Memory v2 Parity Audit | `memory:parity-audit` | memory-v2 到 memory-xx 的规范化缺失/残留检查 |

### MCP（如果启用）

| 功能 | 入口 | 说明 |
|------|------|------|
| MCP Recall | `mcp:recall` | MCP 协议召回 |
| MCP Write | `mcp:write` | MCP 协议写入 |

---

## 🟡 Beta（测试）

> ⚠️ 可用于团队内部试运行，需要保留人工复核

### 自动审批

| 功能 | 入口 | 说明 | 限制 |
|------|------|------|------|
| Auto Approval | `memory:auto-approval` | 自动审批（add-only） | 仅项目/用户 scope，默认禁用 |
| Auto Approval Sweep | `memory:auto-approval-sweep` | 自动审批扫描 | 需配合 production guard |
| Auto Approval Limit Advisor | `memory:auto-approval-limit-advisor` | 限制建议 | 咨询功能 |
| Auto Approval Ops | `memory:auto-approval-ops` | 运维脚本 | 运营使用 |

### 自动更新

| 功能 | 入口 | 说明 | 限制 |
|------|------|------|------|
| Auto Update (dry-run) | `memory:auto-update` | 自动更新 | 仅 dry-run 模式，apply 需单独启用 |

### 对话监听

| 功能 | 入口 | 说明 | 限制 |
|------|------|------|------|
| Conversation Sources | `memory:conversation-sources` | 对话源发现 | beta |
| Conversation Monitor Report | `memory:conversation-monitor-report` | 监听报告 | beta |

### 智能与质量

| 功能 | 入口 | 说明 |
|------|------|------|
| Intelligence Quality | `memory:intelligence-quality` | 智能质量评估 |
| Quality Assessment | `memory:quality` | 质量指标 |
| Trace Feedback | `memory:trace-feedback` | 反馈收集 |

### 图谱

| 功能 | 入口 | 说明 |
|------|------|------|
| Graph Health | `memory:graph-health` | 图谱健康检查 |

### Embedding 校准

| 功能 | 入口 | 说明 |
|------|------|------|
| Embedding Calibrate | `memory:embedding-calibrate` | 校准报告 |

### 策略

| 功能 | 入口 | 说明 |
|------|------|------|
| Policy Evaluation | `memory:policy-eval` | 策略评估 |
| Policy Corpus | `memory:policy-corpus` | 策略语料 |
| Policy Report | `memory:policy-report` | 策略报告 |
| Policy Backfill | `memory:policy-backfill` | 策略元数据回填 |

### 治理（报告）

| 功能 | 入口 | 说明 |
|------|------|------|
| Governance Report | `memory:governance` | 治理报告（只读） |
| Governance Audit | `memory:governance-audit` | 治理审计 |

---

## 🟠 Experimental（实验）

> ⚠️ 报告/候选/观察为主，请勿在生产环境自动化使用

### 演化与报告

| 功能 | 入口 | 说明 |
|------|------|------|
| Memory Evolve Report | `memory:evolve` | 记忆演化报告（仅报告） |
| Debt Plan Report | `memory:debt-plan` | 债务计划报告 |
| Self Improvement Report | `memory:self-improvement` | 自改进建议报告 |

### 图谱

| 功能 | 入口 | 说明 |
|------|------|------|
| Graph Report | `memory:graph-report` | 图谱分析报告 |
| Code Graph | `memory:code-graph` | 代码图谱（项目隔离测试） |

### 时间与衰减

| 功能 | 入口 | 说明 |
|------|------|------|
| Temporal Policy | `memory:temporal-policy` | 时间策略 |
| Temporal Sweep | `memory:temporal-sweep` | 时间清理 |
| Memory Decay | `memory:decay` | 记忆衰减模拟 |

### 整合

| 功能 | 入口 | 说明 |
|------|------|------|
| Memory Consolidate (report) | `memory:consolidate` | 整合候选报告（仅 dry-run） |

### 事件

| 功能 | 入口 | 说明 |
|------|------|------|
| Event Lifecycle Report | `memory:event-lifecycle` | 事件生命周期报告 |

### 清理

| 功能 | 入口 | 说明 |
|------|------|------|
| Governance Cleanup Report | `memory:governance-cleanup` | 清理候选报告（仅 dry-run） |

### 维护

| 功能 | 入口 | 说明 |
|------|------|------|
| Maintenance Report | `memory:maintenance` | 维护报告 |

### 容量

| 功能 | 入口 | 说明 |
|------|------|------|
| Capacity Smoke Test | `memory:capacity-smoke` | 容量冒烟测试 |
| Capacity Audit | `memory:capacity-audit` | 容量审计 |

### 知识

| 功能 | 入口 | 说明 |
|------|------|------|
| Knowledge Markdown | `memory:knowledge-md` | 知识提取 |

---

## 🔴 Dangerous（高风险）

> ⚠️ 测试阶段，请谨慎使用；必须先 dry-run；确认备份和 rollback 方案后再 apply

### Qdrant 操作

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Qdrant Reconcile | `memory:qdrant-reconcile` | 修改真实向量数据 | 使用 `--apply` 会修改真实向量数据，请先使用 dry-run 模式确认影响 |
| Auto Repair | `memory:auto-repair` | 自动修复向量投影 | 使用 `--apply` 会自动修复向量投影，请先备份数据 |

### 自动更新 Apply

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Auto Update Apply | `memory:auto-update:apply` | 修改记忆生命周期 | 使用 `--apply` 会真实修改记忆状态，包含 tombstone 和缓存失效 |
| Auto Update Rollback | `memory:auto-update:rollback` | 恢复旧记忆状态 | 回滚操作会恢复旧记忆状态，请确认有备份方案 |

### 归档 Apply

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Archive Events | `memory:archive-events` | 批量归档事件 | 批量归档事件可能影响审计可追溯性，请谨慎使用 |

### 治理 Apply

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Governance Cleanup Apply | `memory:governance-cleanup:apply` | 批量修改治理状态 | 使用 `--apply` 会批量修改治理状态，请先确认备份方案 |

### 整合 Apply

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Consolidate Apply | `memory:consolidate:apply` | 批量归档或合并记忆 | 使用 `--apply` 会批量归档或合并记忆，请先使用 dry-run 确认 |

### 质量元数据 Apply

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Quality Metadata Backfill | `memory:quality-metadata-backfill` | 批量写入元数据 | 使用 `--apply` 会批量写入元数据，请先确认影响范围 |

### 自动审批（高风险）

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Global Auto Approval | `memory:auto-approval:global` | 影响所有用户和项目 | 全局自动审批会影响所有用户和项目，默认禁用，必须人工确认 |
| Auto Approval Rollback | `memory:auto-approval:rollback` | 改变记忆生命周期 | 回滚自动审批会改变记忆的生命周期状态 |

### 事件重放

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Outbox Recovery Apply | `memory:outbox-recovery:apply` | 重放失败事件 | 事件重放可能触发重复副作用，请确认消息去重机制正常 |

### 批量操作

| 功能 | 入口 | 风险 | 警告 |
|------|------|------|------|
| Bulk Approve | `memory:bulk-approve` | 批量批准 | 批量审批会一次性改变多条记忆状态 |
| Bulk Reject | `memory:bulk-reject` | 批量拒绝 | 批量拒绝会一次性改变多条记忆状态 |
| Bulk Tombstone | `memory:bulk-tombstone` | 永久删除 | 批量墓碑删除会永久移除记忆，无法恢复 |

---

## 判定规则

### stable（稳定）
- 默认可用
- 有测试覆盖
- 有运行或文档证据
- 失败时能降级或给明确错误
- 不会未经显式操作批量改真实数据

### beta（测试）
- 已可用且有测试或 E2E
- 但依赖阈值、scope、guard 或人工复核

### experimental（实验）
- 主要生成报告、候选、校准建议或观察结果
- 默认不应该改变真实状态

### dangerous（高风险）
- 会真实修改记忆生命周期、全局策略、图谱关系、向量投影、审批状态或批量归档
- **必须先 dry-run 再 `--apply`**

---

## 降级原则

1. **没有测试的功能** → 最高只能是 `experimental`（除非只是只读状态查看）
2. **带 `--apply` 的真实写入功能** → 默认至少是 `dangerous`
3. **涉及 global 的自动审批** → 默认是 `dangerous`
4. **涉及 tombstone、archive、repair、reconcile 的批量操作** → 默认是 `dangerous`
5. **只有报告、候选、建议、不落库的能力** → 优先按 `experimental` 或 `beta` 判断

---

## 配置建议

### 生产环境
- 启用所有 `stable` 功能
- 谨慎启用 `beta` 功能，保留人工复核
- 不启用 `experimental` 功能
- 使用 `dangerous` 功能前必须：
  1. 详细阅读警告信息
  2. 使用 `--dry-run` 模式确认影响
  3. 确认有备份和 rollback 方案

### 开发/测试环境
- 可以启用所有 `beta` 功能进行测试
- 可以启用 `experimental` 功能进行探索
- 使用 `dangerous` 功能时同样遵循 dry-run 原则
