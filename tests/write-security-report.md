# memory-xx 写入路径安全与幂等性测试报告

**测试时间：** 2026-05-24
**测试范围：** `/app/write/`, `/app/qdrant-sync/`, `/app/api/intelligence/handlers.ts`
**分析方法：** 代码结构分析 + 设计推理（无运行时沙盒）

---

## 1. 写入完整性

### 1.1 Quality Gate 规则能否被绕过

**测试方法：** 检查 `evaluateExtractionQuality` 调用路径是否在 `CreateMemoryService.execute` 中实际被调用。

**发现的问题：**

`evaluateExtractionQuality` 存在于 `/app/intelligence/quality-gate.ts`，但 `CreateMemoryService.execute`（写入主路径）和 `create-memory-handler.ts`（HTTP 入口）均**没有调用** quality gate。Quality gate 仅在 `/app/api/intelligence/handlers.ts` 的 `handleMemoryExtraction` 流中被调用 —— 那是一条异步提取路径，通过独立 ticket 机制触发，不经过同步写入路径。

这意味着：

- **直接调用 `POST /api/memory/v2/write`（`CreateMemoryService`）写入时，quality gate 不会介入。**
- HTTP 入口只做 `requireTrimmedString` 校验（`content` 不能为空字符串），不做内容质量检查。
- 任何满足 schema 的 payload（即使是纯空格 `"\t\t"`、重复字符、meta phrase 句都可以）都会被写入。

**严重等级：** P1 严重 — 质量门在直接写入路径上完全可绕过

**修复建议：** 在 `CreateMemoryService.execute` 中或 `create-memory-handler.ts` 中，对未经 quality gate 的来源（如 `unified-api`、`tool_output`）注入的内容显式调用 `evaluateExtractionQuality`，或至少对绕过来源做最低长度/SHA 检测。

---

### 1.2 空内容 / 纯空格 / 特殊字符 / 超长内容

**测试方法：** 检查 `normalizeCreateMemoryCommand` 和 `requireTrimmedString` 对 content 的处理。

**发现的问题：**

- `requireTrimmedString` 会 `trim()` 后检查，空白字符内容（`"   "`）会被视为空而抛出错误。✅ 正确
- **但没有最大长度限制**：`content` 字段可传入任意长度字符串。超长内容（>10000 字）会：
  1. 正常写入 PG（`memory_records.content TEXT` 列理论上无限制）
  2. 正常写入 outbox event
  3. 正常触发 projection sync
  4. Qdrant 的 vector 嵌入服务可能超时或 OOM

- **Unicode 特殊字符 / 零宽字符：** `requireTrimmedString` 使用 `trim()` 但不检测 zero-width space、unicode BOM 等，内容可携带隐藏信息。

- **特殊字符 `$`，`\0`：** 路径上使用参数化查询（`$1`, `$2`），无 SQL 注入风险。✅ 正确

**严重等级：** P2 一般 — 缺少内容长度上限，可能导致 Qdrant 嵌入超时或存储爆炸

**修复建议：** 在 `normalizeCreateMemoryCommand` 中添加最大长度校验（如 50000 字），并在 quality gate 级别对超长内容做截断或拒绝。

---

### 1.3 Quality Score 边界行为（0.60 / 0.75 / 0.85 / 0.90）

**测试方法：** 分析 `evaluateExtractionQuality` 的评分边界。

```typescript
const action =
  finalScore >= 0.75 ? "continue" :           // ✅ 通过
  finalScore >= 0.60 ? "candidate_pending" : // ⚠️ 待审核
  "buffer";                                   // ❌ 缓冲
```

**边界精确性：**

| Score | Action | 说明 |
|-------|--------|------|
| 1.00 | continue | 正常 |
| 0.75 | continue ✅ | 刚好及格 |
| 0.74 | candidate_pending ⚠️ | 刚好差一分进缓冲 |
| 0.60 | candidate_pending | 下限 |
| 0.59 | buffer ❌ | 刚好掉出待审核 |

边界逻辑是正确的，但**quality gate 的三个 penalty 是固定值（0.30 / 0.25 / 0.20），最多扣 0.75 分，无法叠加到负数**，这意味着即使是最差的内容也有 0.25 的保底分。

**严重等级：** P3 建议 — 边界正确，但保底分 0.25 意味着最低质量内容仍可能被 "candidate_pending" 而非直接 "buffer"

---

## 2. 语义去重

### 2.1 同 scope 下不同 content hash 但语义相似

**测试方法：** 检查 `SemanticWriteLock` 与 dedupeKey 的关系。

**发现的问题：**

`SemanticWriteLock`（`/app/intelligence/semantic-write-lock.ts`）通过 cosine similarity ≥ 0.95 的 embedding 做并发保护，防止同时写入语义相似内容时 embedding 计算互相等待。但：

1. **`SemanticWriteLock` 是进程内 LRU（内存 Map），不是分布式锁** — 多个 worker 实例各自有独立的 `active` Map，无法跨进程协调。
2. **写入主路径 `CreateMemoryService.execute` 完全没有使用 `SemanticWriteLock`** — 只有 `handleMemoryExtraction`（异步提取路径）使用了它。
3. **语义相似去重（embedding similarity）vs. dedupeKey（exact content hash）：** dedupeKey 只看 exact content string 的 SHA256 前 16 字符，不做语义比较。

**严重等级：** P2 一般 — SemanticWriteLock 是进程内孤岛，写入路径未使用；语义去重依赖 dedupeKey（exact match），无法检测真正语义重复

**修复建议：** 在 `CreateMemoryService.execute` 中集成 `SemanticWriteLock`，或在 dedupeKey 冲突时额外做语义相似度检查（调用 embedding 服务）。

---

### 2.2 LRU 并发保护（N=5 同时写入）

**测试方法：** 分析 `SemanticWriteLock` 的 TTL 和 prune 机制。

**发现的问题：**

- `SemanticWriteLock` 使用 `static readonly active = new Map()`，TTL 30s。
- 每次 `acquire` 时调用 `prune()`，清理已过期的 entries。
- N=5 高相似度 embedding 同时到达：只有第一个获得锁，其余 4 个等待，最多等 5s（`DEFAULT_WAIT_TIMEOUT_MS`），超时后 `timedOut=true` 但**仍然继续执行写入**（`acquire` 返回 `timed_out: true`，调用者仍继续）。

```typescript
const second = await waitPromise;
// second.waited = true, second.timed_out = true
// 调用者仍会继续执行，因为 SemanticWriteLock 不阻止超时后的执行
```

**严重等级：** P2 一般 — LRU 超时降级后不阻止写入，高相似度内容可能并行写入两次

**修复建议：** `SemanticWriteLock` 超时后应返回错误而不是允许继续，或在 `CreateMemoryService.execute` 中检查 `timed_out` 并拒绝写入。

---

### 2.3 进程内 embedding LRU 超时降级路径

**发现的问题：**

同 2.2，超时后 `acquire` 返回 `{ timed_out: true }`，但这个信息**不阻止写入**，只作为 metadata 记录。

**严重等级：** P2 一般

---

## 3. 幂等性与冲突

### 3.1 `dedupeKey` 与 `requestId` 的幂等性保障

**测试方法：** 分析 `RequestIdempotencyService.register` 的双重检查逻辑。

**发现的问题 — 设计正确，但一个边界条件值得注意：**

1. `requestId` 幂等：`insertAccepted` 使用 `ON CONFLICT (request_id) DO NOTHING RETURNING *`。
   - 第一次调用：插入成功，返回 row。
   - 第二次调用：静默忽略，row 为 undefined。
   - 代码处理：`if (inserted)` 判断是否 accepted，否则调用 `resolveExistingRequest`。
   - ⚠️ **边界**：如果两次调用间 PG 连接断开，`ON CONFLICT` 可能产生静默双重成功（取决于事务隔离级别）。建议使用 `INSERT ... ON CONFLICT DO NOTHING` 后显式 `SELECT` 验证。

2. `dedupeKey` 冲突：使用 `pg_advisory_xact_lock`（事务级别）保护，检查 existing → supersede。
   - ⚠️ **边界**：如果 existing record 的 `content` 完全相同（不同 `requestId`），会被 **supersede** 而不是跳过。这意味着相同内容的重复请求会创建一个新 version，而不是被幂等拒绝。

3. **payload hash 冲突检测**：同一个 `requestId` 传不同 payload → 抛 `RequestPayloadConflictError`。✅ 正确

**严重等级：** P3 建议 — dedupeKey 冲突时不应总是 supersede，应检查 content 是否真的不同

---

### 3.2 PG Advisory Lock 并发保护

**发现的问题：**

```typescript
await tx.query(
  "SELECT pg_advisory_xact_lock(hashtext($1))",
  [`${normalizedCommand.scopeType}:${normalizedCommand.scopeId}:${normalizedCommand.dedupeKey}`]
);
```

- `hashtext(string)` 将字符串转为 bigint，**不保证唯一性**（哈希碰撞理论上可能）。
- 使用 `xact_lock`（事务结束时自动释放），在事务内部调用顺序正确。
- 如果 dedupeKey 为 `null`（`normalizedCommand.dedupeKey` 是 `string | null`），不会进入 dedupeKey 分支，跳过 lock。

**严重等级：** P3 建议 — null dedupeKey 跳过 advisory lock，并发写入同一 null dedupeKey 的内容不受保护

---

### 3.3 投影（projection）的 idempotency key 冲突处理

**测试方法：** 检查 `QdrantProjectionSyncService.findIdempotentUpserts` 逻辑。

**发现的问题 — 一个设计缺陷：**

```typescript
private async findIdempotentUpserts(upserts: readonly QdrantPointUpsert[]): Promise<Set<string>> {
  // ...
  try {
    points = await this.pointWriter.retrieve(upserts.map((point) => point.id));
  } catch {
    return idempotent; // ⚠️ 检索失败时返回空 set，所有点都被认为需要写入
  }
  // 对比 projection_hash
  if (actual?.payload?.projection_hash === point.payload.projection_hash) {
    idempotent.add(point.payload.memory_id);
  }
  return idempotent;
}
```

- **如果 Qdrant retrieve 超时或失败**：`findIdempotentUpserts` 捕获异常后返回**空 set**，意味着所有本应 idempotent 的 upserts 都会重新写入。
- 这不是"写入失败"，而是**重复写入**，可能导致 Qdrant 中的数据被覆盖（幂等性破坏）。
- `verifyReadback` 在 upsert 后检查，但如果 retrieve 在 idempotency check 阶段失败，后续 verify 时才暴露问题。

**严重等级：** P1 严重 — Qdrant 检索失败时幂等性保障静默失效，相同 memory 可被重复写入

---

## 4. 投影可靠性

### 4.1 Qdrant upsert 失败后 readback verify 重试

**发现的问题：**

```typescript
if (upsertsToWrite.length > 0) {
  await this.pointWriter.upsert(upsertsToWrite);
  await this.verifyReadback(upsertsToWrite); // 只验证一次，不重试
}

private async verifyReadback(upserts: readonly QdrantPointUpsert[]): Promise<void> {
  // ...
  const actualHash = actual?.payload?.projection_hash;
  if (actualHash !== point.payload.projection_hash) {
    throw new Error(`projection_verify_failed:${point.payload.memory_id}`);
  }
}
```

- `verifyReadback` **只执行一次**，失败直接抛异常，不重试。
- 异常被 `QdrantProjectorWorker.drainOnce` 捕获，触发 retry 或 dead-letter。
- 但 `syncMemoryIds`（被 `CreateMemoryService` 的 post-commit 调用）**没有 retry 逻辑**：如果 upsert 成功但 verify 失败，异常上抛，PG transaction 已提交，投影不一致。

**严重等级：** P1 严重 — post-commit 投影验证失败时没有重试，导致 PG 已提交但 Qdrant 数据不一致

---

### 4.2 3次失败后 dead-letter 是否正确

**测试方法：** 检查 `QdrantProjectorWorker.drainOnce` 的 retry 逻辑。

**发现的问题 — 逻辑正确，但有一个边界条件：**

```typescript
const nextAttempts = event.attempts + 1;
if (nextAttempts >= this.maxAttempts) { // maxAttempts = 5
  await this.deps.outboxRepository.markDeadLetter({...});
  return { status: "dead_letter", ... };
}
```

- `markDeadLetter` 将 `dispatch_status` 设为 `Failed`，不触发 further retry。✅ 正确
- 但 `markDeadLetter` 后 **Qdrant 中数据仍然缺失或不一致**，需要人工干预或 replay 机制修复。
- `replay-repair.ts` 提供了一定修复能力，但写入路径本身没有补偿机制。

**严重等级：** P2 一般 — dead-letter 后数据不一致，需要显式 replay 修复，没有自动补偿

---

### 4.3 outbox consumer 的 consumed lock 正确处理

**发现的问题：**

`claimProcessableEvents` 使用 `FOR UPDATE SKIP LOCKED` 原子 claim，确保多 worker 不重复处理同一 event。✅ 正确

- claim 后设置 `dispatchStartedAt`，防止其他 worker 重复 claim。
- `markRetry` 重置 `dispatchStartedAt = null`，允许下次重试。

**严重等级：** P3 建议 — retry 时没有 backoff count 上限检查（依赖 `maxAttempts` 在 SQL 层面过滤），但这已经是正确设计

---

## 5. Silent Approve

### 5.1 trusted agent + quality ≥ 0.85 + confidence ≥ 0.90 条件

**测试方法：** 分析 `approvalForMemory` 函数。

**发现的问题 — 三个细节问题：**

**问题 A：scope multiplier 在 confidence 比较之前应用**

```typescript
const scopeMultiplier =
  input.memory.scope_type === "workspace" ? 0.95 :
    input.memory.scope_type === "global" ? 0.90 :
      1.0;
const adjustedConfidence = Math.min(input.extractionConfidence, input.memory.confidence) * scopeMultiplier;
```

- 对于 `workspace` scope：effective threshold 是 `0.90 * 0.95 = 0.855`
- 对于 `global` scope：effective threshold 是 `0.90 * 0.90 = 0.81`

**这意味着 global scope 的 silent approve 阈值实际上是 0.81，不是 0.90。** 任务描述中的"0.90"条件在 global scope 下被隐性放宽。

**问题 B：`operation === "add"` 门控**

```typescript
if (
  input.memory.operation === "add" &&  // ⚠️ 只对 add 操作 silent approve
  qualityScore >= 0.85 &&
  !input.hasSemanticConflict &&
  adjustedConfidence >= (input.silentApproveThreshold ?? 0.90)
)
```

- **只对 `operation === "add"` 触发 silent approve**，`update` / `merge` 操作永远不能 silent approve。
- 如果 `handleMemoryExtraction` 没有设置 `operation` 字段（默认为其他值），silent approve 永远不会触发。

**问题 C：quality score fallback 使用 `extractionConfidence`**

```typescript
function qualityScoreOf(memory: ExtractedMemory, fallback: number): number {
  return memory.quality_gate?.score ?? fallback;
}
```

- 当 `quality_gate.score` 不存在时，用 `extractionConfidence` 替代。
- `extractionConfidence` 可能低于 0.85（甚至为 0），导致 fallback 后质量分不足。

**严重等级：** P2 一般 — scope multiplier 隐性降低阈值；operation 字段门控可能意外屏蔽 silent approve

---

### 5.2 scope multiplier 生效

**见上文 5.1 问题 A。**

---

## 6. 事务边界

### 6.1 PG 连接断开时的回滚

**发现的问题：**

`withWriteTransaction` 在 PG 连接断开时会抛出异常，被 `CreateMemoryService.execute` 的 try/catch 捕获：

```typescript
} catch (error) {
  const writeError = error instanceof WriteError ? error
    : new WriteError(WriteErrorCode.TransactionConstraintViolation, ...);
  await this.requestIdempotencyService.markFailed(normalizedCommand.requestId, writeError);
  throw writeError;
}
```

- 事务回滚由 PG driver 处理。✅ 正确
- 但如果**连接在 commit 后断开**（post-commit），`markCompleted` 可能无法执行，导致 request 停留在 `accepted` 状态。
- 下次相同 `requestId` 重试时会被 replay（`markCompleted` 未执行，status 仍为 `accepted`），但 payload 一致性取决于 `touch` 的行为。

**严重等级：** P2 一般 — commit 后连接断开可能导致 request 停留在 accepted，replay 时行为取决于 touch 实现

---

### 6.2 写入 PG 成功但 Qdrant 失败 — 一致性保障

**发现的问题 — 最关键的架构缺陷：**

```
POST /api/memory/v2/write
  → CreateMemoryService.execute()
      → withWriteTransaction() { PG 写入 }  ← 事务边界
      → projectionSyncService.syncWriteResult()  ← post-commit，无事务保护
```

- **PG 写入和 Qdrant 写入不在同一事务中**。
- 如果 `projectionSyncService.syncWriteResult()` 失败：
  - PG transaction 已提交，数据持久化
  - Qdrant 中没有对应 point
  - outbox event 已在 PG 中，但 worker 可能也在处理失败
  - 缓存失效（`cacheInvalidator.invalidate`）也可能失败

- **`CreateMemoryService` 对 post-commit 失败做了 degraded 记录**，但：
  - 没有**补偿事务**或 saga 机制
  - 没有**outbox replay** 自动修复投影不一致
  - 依赖于 `QdrantProjectorWorker` 从 outbox 事件中恢复（异步，且可能死信）

- **如果 outbox event 本身写入 PG 失败**（如 `FailingOutboxEventRepository`），整个 transaction 回滚。✅ 正确

**严重等级：** P0 崩溃 — PG 提交成功但 Qdrant 写入失败时，无自动补偿，导致 PG 和 Qdrant 永久不一致；outbox 是恢复的唯一路径但依赖 daemon 正常运行

---

## 问题汇总表

| ID | 测试点 | 发现的问题 | 严重等级 |
|----|--------|-----------|---------|
| Q01 | Quality Gate 绕过 | 直接写入路径（CreateMemoryService）不经过 quality gate | P1 严重 |
| Q02 | 内容长度限制 | 无最大长度限制，超长内容可写入 | P2 一般 |
| Q03 | 零宽字符检测 | content 可含零宽字符，无过滤 | P3 建议 |
| Q04 | SemanticWriteLock 跨进程 | LRU Map 是进程内孤岛，多 worker 实例无法协调 | P2 一般 |
| Q05 | 写入主路径不使用 SemanticWriteLock | CreateMemoryService 未集成 semantic lock | P2 一般 |
| Q06 | LRU 超时后不阻止写入 | timed_out=true 仍继续执行写入 | P2 一般 |
| Q07 | dedupeKey null 跳过 advisory lock | 并发写入同一 null dedupeKey 不受保护 | P3 建议 |
| Q08 | Qdrant retrieve 失败时幂等性破坏 | idempotency check 异常后空 set 导致重复覆盖写入 | P1 严重 |
| Q09 | verifyReadback 无重试 | post-commit 投影验证失败无 retry，永久不一致 | P1 严重 |
| Q10 | dead-letter 后无自动补偿 | 数据不一致需人工 replay，无自动恢复 | P2 一般 |
| Q11 | scope multiplier 隐性降低阈值 | global scope effective threshold = 0.81 非 0.90 | P2 一般 |
| Q12 | operation="add" 门控 | silent approve 只对 add 操作生效，可能意外屏蔽 | P2 一般 |
| Q13 | commit 后连接断开 | request 停留在 accepted，replay 行为不确定 | P2 一般 |
| Q14 | PG/Qdrant 无分布式事务 | PG 提交成功 + Qdrant 失败 → 永久不一致，无 saga | P0 崩溃 |

---

## 修复优先级建议

**P0（立即修复）：**
- Q01：质量门绕过 — 在写入路径中集成 quality gate
- Q08：Qdrant retrieve 失败幂等性 — idempotency check 失败时应跳过而非覆盖
- Q14：分布式事务一致性 — 考虑 outbox + idempotent projection 作为唯一恢复路径；或引入 saga/补偿事务

**P1（近期修复）：**
- Q09：verifyReadback 重试机制
- Q05：CreateMemoryService 集成 SemanticWriteLock

**P2（规划中修复）：**
- Q02：添加内容长度上限
- Q11：重新设计 scope multiplier 阈值文档和实现
- Q10：dead-letter 自动告警 + replay 机制

**P3（代码清理）：**
- Q03：Unicode 零宽字符过滤
- Q07：null dedupeKey 时使用 fallback key