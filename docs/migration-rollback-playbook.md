# Migration Rollback Playbook

> **定位**：本文定义 memory-xx-next 所有 schema 迁移的回退策略、down migration 规范和演练流程。

---

## 一、原则

1. **每个 up migration 必须有对应的 down migration 或回退策略文档**，否则不允许上线。
2. **enum 值回退前**：先检查生产环境是否已被使用（`SELECT DISTINCT ...`），未被使用才可回退；已使用时必须保留值或标记 deprecated。
3. **新表 DROP 前**：必须确认数据已归档（`SELECT COUNT(*)` 确认后导出），或确认业务已不再依赖该表。
4. **字段回退**：`ADD COLUMN` 使用 `DROP COLUMN IF EXISTS`；`ALTER TYPE` 使用 `ALTER TYPE ... RENAME TO` + 重建。
5. **降级兼容**：down migration 执行后，旧版应用必须能正常工作（不产生缺失列/缺失类型错误）。
6. **演练**：每次迁移先在 shadow 环境跑 `up → 验证 → down → 验证` 的完整循环。

---

## 二、当前 Migration 回退策略

### 0015 — Write Path Hardening

**up 内容**：新增 `write_tickets`、`low_confidence_buffer`、`memory_feedback_events` 表。

**down SQL 模板**：
```sql
-- 0015 down: drop write path hardening tables
DROP TABLE IF EXISTS memory_xx.memory_feedback_events;
DROP TABLE IF EXISTS memory_xx.low_confidence_buffer;
DROP TABLE IF EXISTS memory_xx.write_tickets;
```

**安全边界**：
- `memory_feedback_events` 回退前确认 `SELECT COUNT(*) < 1000`（建议归档）
- `write_tickets` 回退前确认所有 ticket 已 terminal（`completed/skipped/cancelled/failed`）

### 0016 — Governance Control Loop

**up 内容**：新增 `memory_governance_runs`、`memory_governance_actions`、`memory_governance_freezes`、`governance_policy_overrides`、`recall_repair_queue`、`recall_traces`、`recall_feedback_events` 表。

**down SQL 模板**：
```sql
-- 0016 down: drop governance control loop tables
DROP TABLE IF EXISTS memory_xx.recall_feedback_events;
DROP TABLE IF EXISTS memory_xx.recall_traces;
DROP TABLE IF EXISTS memory_xx.recall_repair_queue;
DROP TABLE IF EXISTS memory_xx.governance_policy_overrides;
DROP TABLE IF EXISTS memory_xx.memory_governance_freezes;
DROP TABLE IF EXISTS memory_xx.memory_governance_actions;
DROP TABLE IF EXISTS memory_xx.memory_governance_runs;
```

**安全边界**：
- `memory_governance_actions` 回退前导出 `SELECT *` 到 JSON
- `recall_traces` 数据量大（每小时写入），只保留最近 7 天汇总
- `governance_policy_overrides` 回退后确认没有活跃 override 在运行

### 0017a — Governance Run Lease

**up 内容**：`memory_governance_runs` 增加 `lease_expires_at`、`heartbeat_at`、`lease_acquired_by` 列。

**down SQL 模板**：
```sql
-- 0017a down: drop lease columns
DROP INDEX IF EXISTS memory_xx.idx_memory_governance_runs_lease_expiry;
DROP INDEX IF EXISTS memory_xx.idx_memory_governance_runs_active_lease;
ALTER TABLE memory_xx.memory_governance_runs
  DROP COLUMN IF EXISTS lease_acquired_by,
  DROP COLUMN IF EXISTS heartbeat_at,
  DROP COLUMN IF EXISTS lease_expires_at;
```

**安全边界**：
- 回退前确认没有活跃的 governance worker 持有 lease（`lease_acquired_by IS NOT NULL`）
- 回退后 governance worker 会退回到 transaction-level advisory lock

### 0017b — Scope Generations

**up 内容**：新增 `scope_generations` 表。

**down SQL 模板**：
```sql
-- 0017b down: drop scope generations table
DROP TABLE IF EXISTS memory_xx.scope_generations;
```

**安全边界**：
- 回退后 recall cache 不再基于 generation 版本号失效，退回到纯 Redis TTL + 显式删除

### 0018 — Recall Repair Root Cause Type

**up 内容**：`recall_repair_queue` 增加 `root_cause_type` 列（如果不存在）。

**down SQL 模板**：
```sql
-- 0018 down: drop root_cause_type column
ALTER TABLE memory_xx.recall_repair_queue
  DROP COLUMN IF EXISTS root_cause_type;
```

**安全边界**：
- 回退后 recall repair 逻辑退回到纯文本 `root_cause` 字段

### Silent Approved Enum 值（ReviewState）

**up**：ReviewState 已包含 `SilentApproved = "silent_approved"`。

**回退策略**：
```sql
-- 检查是否已被使用
SELECT review_state, COUNT(*) FROM memory_xx.memory_records
WHERE review_state = 'silent_approved'
GROUP BY review_state;

-- 如果已有记录，不能直接删除 enum 值；改为保留值但不再使用
-- 如果没有记录，保留值（PG 不支持从 enum 安全删除值）
```

**注意**：PostgreSQL 不支持安全地从 enum 类型删除值。如果必须回退，最安全的做法是：
1. 确认无记录使用该值
2. 或者不删除值，仅在新代码中不再引用

### GovernanceTriggered / GovernanceActionId 字段

**up**：`memory_feedback_events` 增加 `governance_triggered` (boolean) 和 `governance_action_id` (text) 列。

**down SQL 模板**：
```sql
ALTER TABLE memory_xx.memory_feedback_events
  DROP COLUMN IF EXISTS governance_action_id,
  DROP COLUMN IF EXISTS governance_triggered;
```

### Trusted Agents 表

**up**：新增 `trusted_agents` 表。

**down SQL 模板**：
```sql
DROP TABLE IF EXISTS memory_xx.trusted_agents;
```

**安全边界**：
- 回退后权限判断退回到 env list（`TRUSTED_AGENTS` 环境变量）
- 回退前导出 `SELECT * FROM memory_xx.trusted_agents` 以便后续重建

### Write Tickets Archive 表

**up**：新增 `write_tickets_archive` 表（migration 0015 或后续）。

**down SQL 模板**：
```sql
DROP TABLE IF EXISTS memory_xx.write_tickets_archive;
```

**安全边界**：
- 回退前确认归档数据已导出或不再需要

---

## 三、Down Migration 编写规范

1. **文件命名**：`migrations/XXXX_down_<描述>.sql`，其中 XXXX 与 up migration 编号一致。
2. **幂等性**：所有 `DROP COLUMN` 和 `DROP TABLE` 使用 `IF EXISTS`。
3. **顺序**：down migration 按 up 的逆序执行（后加的先删）。
4. **注释**：每个 `DROP` 操作前加注释说明回退原因和影响。
5. **索引**：drop column 前先 drop 依赖该列的索引。
6. **数据检查**：down migration 脚本开头可选注释说明如何检查数据是否已使用。

**模板**：
```sql
-- Down migration for <描述>
-- 回退前检查：SELECT ... 确认数据已归档或未使用

-- Drop indexes first
DROP INDEX IF EXISTS memory_xx.idx_xxx;

-- Drop columns/tables
ALTER TABLE memory_xx.xxx DROP COLUMN IF EXISTS yyy;
DROP TABLE IF EXISTS memory_xx.zzz;
```

---

## 四、回退演练流程

```bash
# 1. 在 shadow 数据库运行 up migration
MEMORY_XX_ENV_PATH=/path/to/shadow/.env npm run migrate

# 2. 验证 shadow 库结构
psql $SHADOW_DB_URL -c "\dt memory_xx.*"

# 3. 运行 down migration（手动执行或迁移脚本）
psql $SHADOW_DB_URL -f migrations/0015_down_write_path_hardening.sql

# 4. 验证回退后结构
psql $SHADOW_DB_URL -c "\dt memory_xx.*"

# 5. 重新运行 up migration 确认可恢复
MEMORY_XX_ENV_PATH=/path/to/shadow/.env npm run migrate

# 6. 运行 typecheck + test 确认应用兼容
MEMORY_XX_ENV_PATH=/path/to/shadow/.env npm run typecheck
MEMORY_XX_ENV_PATH=/path/to/shadow/.env npm test
```

---

## 五、批量回退（全量版本回滚）

如果需要回退到某个早期版本（如 v1.0），执行顺序：

1. 按 migration 编号 **从大到小** 逐级执行 down migration
2. 每级回退后验证应用兼容性
3. 全量回退后执行 `npm run typecheck` 确认代码与 schema 一致
4. 通知所有依赖方 schema 已变更

**不推荐**直接 DROP schema 重建（除非是 shadow/dev 环境）。
