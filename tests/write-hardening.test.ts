import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryWriteDatabase,
  LifecycleStatus,
  ReviewState,
  ScopeType,
  isEffectiveRecallable,
} from "../app";
import { evaluateExtractionQuality } from "../app/intelligence/quality-gate";
import { SessionAnchorStore } from "../app/intelligence/session-anchors";
import { SemanticWriteLock } from "../app/intelligence/semantic-write-lock";
import { WriteTicketRepository } from "../app/db/repositories/write-ticket-repository";
import { IngestRequestRepository } from "../app/db/repositories/ingest-request-repository";
import { CacheInvalidationRequestRepository } from "../app/db/repositories/cache-invalidation-request-repository";
import { LowConfidenceBufferRepository } from "../app/db/repositories/low-confidence-buffer-repository";
import { IngestRequestStatus, WriteCommandType } from "../app/shared/contracts/write";
import { isInMemoryTransactionContext, withWriteTransaction } from "../app/db/tx/write-transaction";
import { RecallRuntimeCacheInvalidator, type RecallCacheRuntime } from "../app/cache";

test("quality score keeps single length anomaly at the 0.75 pass boundary", () => {
  const result = evaluateExtractionQuality({
    inputText: "生产环境每次发布前先通知团队，然后等待负责人确认。",
    canonicalContent: "发布前先通知团队，然后等确认。该流程适用于所有生产发布和回滚发布，并且需要在群内同步确认结果。",
  });
  assert.equal(result.score, 0.75);
  assert.equal(result.action, "continue");
  assert.equal(result.passed, true);
  assert.deepEqual(result.flags, ["length_ratio"]);
});

test("quality score stacks multiple rule hits into low confidence buffer range", () => {
  const result = evaluateExtractionQuality({
    inputText: "用蓝色",
    canonicalContent: "用户说请记住：系统 UI 使用蓝色，并新增 API 与 CI/CD 规则。",
  });
  assert.equal(result.score < 0.6, true);
  assert.equal(result.action, "buffer");
  assert.equal(result.flags.includes("meta_phrase"), true);
  assert.equal(result.flags.includes("expansion_risk"), true);
});

test("session anchors preserve high-priority decisions when evicting", () => {
  SessionAnchorStore.clear();
  const store = new SessionAnchorStore();
  for (let i = 0; i < 8; i += 1) {
    store.rememberAnchor({ session_id: "s1", memory_type: "preference", topic: `pref-${i}`, anchor_id: `pref-${i}` });
  }
  store.rememberAnchor({ session_id: "s1", memory_type: "decision", topic: "release", anchor_id: "decision-1" });
  store.rememberAnchor({ session_id: "s1", memory_type: "constraint", topic: "deploy", anchor_id: "constraint-1" });
  store.rememberAnchor({ session_id: "s1", memory_type: "fact", topic: "fact", anchor_id: "fact-1" });
  const context = store.getContext({ session_id: "s1" });
  assert.equal(context.anchor_hit, true);
  assert.equal(context.anchor_id, "fact-1");
});

test("semantic write lock waits for similar in-flight embedding", async () => {
  SemanticWriteLock.clear();
  const lock = new SemanticWriteLock();
  const first = await lock.acquire({ scopeType: "project", scopeId: "p1", embedding: [1, 0, 0], waitTimeoutMs: 100 });
  const waitPromise = lock.acquire({ scopeType: "project", scopeId: "p1", embedding: [0.99, 0.01, 0], waitTimeoutMs: 500 });
  setTimeout(() => first.release(), 10);
  const second = await waitPromise;
  assert.equal(second.waited, true);
  assert.equal(second.timed_out, false);
  second.release();
});

test("redis semantic lock config falls back only for single-wrapper deployments without redis url", async () => {
  SemanticWriteLock.clear();
  const oldBackend = process.env.MEMORY_V2_SEMANTIC_LOCK_BACKEND;
  const oldCount = process.env.MEMORY_V2_INSTANCE_COUNT;
  const oldRedis = process.env.MEMORY_V2_REDIS_URL;
  try {
    process.env.MEMORY_V2_SEMANTIC_LOCK_BACKEND = "redis";
    process.env.MEMORY_V2_INSTANCE_COUNT = "1";
    delete process.env.MEMORY_V2_REDIS_URL;
    const single = await new SemanticWriteLock().acquire({
      scopeType: "project",
      scopeId: "p1",
      embedding: [1, 0, 0],
      waitTimeoutMs: 10,
    });
    assert.equal(single.timed_out, false);
    single.release();

    process.env.MEMORY_V2_INSTANCE_COUNT = "2";
    await assert.rejects(
      new SemanticWriteLock().acquire({
        scopeType: "project",
        scopeId: "p1",
        embedding: [1, 0, 0],
        waitTimeoutMs: 10,
      }),
      /redis_semantic_lock_unconfigured/
    );
  } finally {
    if (oldBackend === undefined) delete process.env.MEMORY_V2_SEMANTIC_LOCK_BACKEND;
    else process.env.MEMORY_V2_SEMANTIC_LOCK_BACKEND = oldBackend;
    if (oldCount === undefined) delete process.env.MEMORY_V2_INSTANCE_COUNT;
    else process.env.MEMORY_V2_INSTANCE_COUNT = oldCount;
    if (oldRedis === undefined) delete process.env.MEMORY_V2_REDIS_URL;
    else process.env.MEMORY_V2_REDIS_URL = oldRedis;
  }
});

test("write ticket timeout moves pending ticket to failed_extraction", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-19T00:00:00.000Z");
  const repo = new WriteTicketRepository();
  const ticket = await withWriteTransaction(db, (tx) => repo.create(tx, {
    idempotencyKey: "idem-1",
    actorId: "agent",
    agentId: "agent",
    requestJson: {},
    ttlSeconds: 1,
  }));
  assert.equal(ticket.status, "pending_extraction");

  const laterDb = db as InMemoryWriteDatabase;
  await laterDb.withTransaction(async (tx) => {
    assert.equal(isInMemoryTransactionContext(tx), true);
    if (!isInMemoryTransactionContext(tx)) return;
    const row = tx.state.writeTickets.find((item) => item.id === ticket.id);
    assert.ok(row);
    tx.state.writeTickets[0] = { ...row, expiresAt: "2026-05-18T23:59:59.000Z" };
  });
  const failed = await withWriteTransaction(db, (tx) => repo.failExpired(tx));
  const snapshot = await db.snapshot();
  assert.equal(failed, 1);
  assert.equal(snapshot.writeTickets[0].status, "failed_extraction");
  assert.equal(snapshot.writeTickets[0].failureReason, "async_ticket_timeout");
});

test("accepted ingest request lease expiry becomes recoverable and can be re-accepted", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-19T00:00:00.000Z");
  const repo = new IngestRequestRepository();
  await withWriteTransaction(db, (tx) => repo.insertAccepted(tx, {
    requestId: "req-accepted-lease",
    commandType: WriteCommandType.CreateMemory,
    payloadHash: "hash-a",
    payloadJson: "{}",
    actorId: "agent",
  }));
  await db.withTransaction(async (tx) => {
    assert.equal(isInMemoryTransactionContext(tx), true);
    if (!isInMemoryTransactionContext(tx)) return;
    tx.state.ingestRequests[0] = {
      ...tx.state.ingestRequests[0],
      leaseExpiresAt: "2026-05-18T23:59:59.000Z",
    };
  });
  const expired = await withWriteTransaction(db, (tx) => repo.recoverExpiredAccepted(tx));
  assert.equal(expired, 1);
  let row = (await db.snapshot()).ingestRequests[0];
  assert.equal(row.status, IngestRequestStatus.Failed);
  assert.equal(row.recoverable, true);
  assert.equal(row.errorCode, "accepted_lease_expired");

  const recovered = await withWriteTransaction(db, (tx) => repo.recoverAccepted(tx, "req-accepted-lease"));
  assert.ok(recovered);
  row = (await db.snapshot()).ingestRequests[0];
  assert.equal(row.status, IngestRequestStatus.Accepted);
  assert.equal(row.recoverable, false);
  assert.ok(row.leaseOwner);
});

test("write ticket worker lease claim prevents duplicate processing", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-19T00:00:00.000Z");
  const repo = new WriteTicketRepository();
  await withWriteTransaction(db, (tx) => repo.create(tx, {
    idempotencyKey: "idem-worker",
    actorId: "agent",
    agentId: "agent",
    requestJson: { text: "remember worker lease" },
    ttlSeconds: 120,
  }));

  const first = await withWriteTransaction(db, (tx) => repo.claimNext(tx, { workerId: "worker-a", limit: 1 }));
  const second = await withWriteTransaction(db, (tx) => repo.claimNext(tx, { workerId: "worker-b", limit: 1 }));
  assert.equal(first.length, 1);
  assert.equal(first[0].status, "processing_extraction");
  assert.equal(first[0].leaseOwner, "worker-a");
  assert.equal(first[0].attempts, 1);
  assert.equal(second.length, 0);
});

test("cache invalidation requests are durable and claimable", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-19T00:00:00.000Z");
  const repo = new CacheInvalidationRequestRepository();
  const queued = await withWriteTransaction(db, (tx) => repo.enqueue(tx, {
    scopeType: ScopeType.Project,
    scopeId: "p1",
    reason: "redis:down",
  }));
  const claimed = await withWriteTransaction(db, (tx) => repo.claimNext(tx, { workerId: "cache-worker" }));
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, queued.id);
  assert.equal(claimed[0].status, "processing");
  await withWriteTransaction(db, (tx) => repo.markCompleted(tx, queued.id));
  const snapshot = await db.snapshot();
  assert.equal(snapshot.cacheInvalidationRequests[0]?.status, "completed");
  assert.ok(snapshot.cacheInvalidationRequests[0]?.completedAt);
});

test("cache invalidation claim skips requests above max attempts", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-19T00:00:00.000Z");
  const repo = new CacheInvalidationRequestRepository();
  const queued = await withWriteTransaction(db, (tx) => repo.enqueue(tx, {
    scopeType: ScopeType.Project,
    scopeId: "p1",
    reason: "fastpath_http_503",
  }));
  await withWriteTransaction(db, (tx) => repo.markFailed(tx, queued.id, "fastpath_http_503", 0));
  await withWriteTransaction(db, (tx) => repo.claimNext(tx, { workerId: "cache-worker", maxAttempts: 1 }));
  await withWriteTransaction(db, (tx) => repo.markFailed(tx, queued.id, "fastpath_http_503", 0));
  const claimed = await withWriteTransaction(db, (tx) => repo.claimNext(tx, { workerId: "cache-worker", maxAttempts: 1 }));
  assert.equal(claimed.length, 0);
});

test("strict cache invalidator treats fastpath 404 as success", async () => {
  const cache: RecallCacheRuntime = {
    getSearch: async () => null,
    setSearch: async () => ({ status: "skipped" }),
    getStartupContext: async () => null,
    setStartupContext: async () => ({ status: "skipped" }),
    getSession: async () => null,
    rememberSession: async () => ({ status: "skipped" }),
    getRecent: async () => null,
    rememberRecent: async () => ({ status: "skipped" }),
    invalidateScopes: async () => undefined,
    getHealthSnapshot: async () => ({}),
    close: async () => undefined,
  };
  const invalidator = new RecallRuntimeCacheInvalidator(cache, {
    strict: true,
    persistFailures: false,
    fastpathEnabled: true,
    fetcher: async () => new Response("", { status: 404 })
  });
  await invalidator.invalidate([{ type: ScopeType.Project, id: "p1" }]);
});

test("strict cache invalidator surfaces fastpath auth errors", async () => {
  const cache: RecallCacheRuntime = {
    getSearch: async () => null,
    setSearch: async () => ({ status: "skipped" }),
    getStartupContext: async () => null,
    setStartupContext: async () => ({ status: "skipped" }),
    getSession: async () => null,
    rememberSession: async () => ({ status: "skipped" }),
    getRecent: async () => null,
    rememberRecent: async () => ({ status: "skipped" }),
    invalidateScopes: async () => undefined,
    getHealthSnapshot: async () => ({}),
    close: async () => undefined,
  };
  const invalidator = new RecallRuntimeCacheInvalidator(cache, {
    strict: true,
    persistFailures: false,
    fastpathEnabled: true,
    fetcher: async () => new Response("", { status: 403 })
  });
  await assert.rejects(
    () => invalidator.invalidate([{ type: ScopeType.Project, id: "p1" }]),
    /fastpath_http_403/
  );
});

test("low confidence buffer exposes retry, retried, and abandoned lifecycle", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-19T00:15:00.000Z");
  const repo = new LowConfidenceBufferRepository();
  const row = await withWriteTransaction(db, (tx) => repo.add(tx, {
    requestId: "req-low-confidence",
    actorId: "agent",
    scopeType: "project",
    scopeId: "p1",
    inputText: "记住这个但抽取很差",
    extraction: {},
    qualityGate: { score: 0.5 },
  }));
  await db.withTransaction(async (tx) => {
    assert.equal(isInMemoryTransactionContext(tx), true);
    if (!isInMemoryTransactionContext(tx)) return;
    tx.state.lowConfidenceBuffer[0] = {
      ...tx.state.lowConfidenceBuffer[0],
      nextRetryAt: "2026-05-19T00:10:00.000Z",
      createdAt: "2026-05-17T23:59:00.000Z",
    };
  });

  const due = await withWriteTransaction(db, (tx) => repo.listDueForRetry(tx));
  assert.equal(due.length, 1);
  assert.equal(due[0]?.id, row.id);
  await withWriteTransaction(db, (tx) => repo.markRetried(tx, row.id));
  const abandoned = await withWriteTransaction(db, (tx) =>
    repo.markAbandonedOlderThan(tx, "2026-05-18T00:15:00.000Z")
  );
  const snapshot = await db.snapshot();

  assert.equal(abandoned, 1);
  assert.equal(snapshot.lowConfidenceBuffer[0]?.status, "abandoned");
  assert.equal(snapshot.lowConfidenceBuffer[0]?.retryCount, 1);
});

test("silent_approved memories are effective recallable", () => {
  assert.equal(isEffectiveRecallable({
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.SilentApproved,
    isCurrent: true,
  }), true);
  assert.equal(ScopeType.Project, "project");
});
