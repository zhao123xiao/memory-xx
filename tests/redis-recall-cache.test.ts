import assert from "node:assert/strict";
import test from "node:test";

import {
  CreateMemoryService,
  FilterMode,
  InMemoryWriteDatabase,
  LifecycleStatus,
  QueryType,
  RecallOrchestrator,
  RedisRecallCache,
  RetrievalStrategy,
  ReviewState,
  ScopeType,
  StubVectorRetriever,
  type RecallRequest,
  type RecallResponse,
  type RecallScopeRef,
  type LexicalRetriever,
  type QueryConstraints
} from "../app";
import { buildSearchCacheKey } from "../app/cache/keys";
import type { BackendStatus, RetrieverCandidate } from "../app/recall/types";

class FakeRedisClient {
  readonly store = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  isOpen = false;

  async connect(): Promise<void> { this.isOpen = true; }
  async quit(): Promise<void> { this.isOpen = false; }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async set(key: string, value: string): Promise<string> { this.store.set(key, value); return "OK"; }
  async del(keys: string | string[]): Promise<number> {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of list) {
      if (this.store.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
    }
    return deleted;
  }
  async sAdd(key: string, members: string | string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of Array.isArray(members) ? members : [members]) {
      set.add(member);
    }
    this.sets.set(key, set);
    return set.size;
  }
  async sMembers(key: string): Promise<string[]> { return [...(this.sets.get(key) ?? new Set<string>())]; }
  async expire(): Promise<boolean> { return true; }
  async ping(): Promise<string> { return "PONG"; }
  on(): void {}
}

class FlakyRedisClient extends FakeRedisClient {
  failGet = true;
  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error("redis_down");
    return super.get(key);
  }
}

class StubLexicalRetriever implements LexicalRetriever {
  constructor(private readonly candidates: RetrieverCandidate[]) {}
  async retrieve(_input: QueryConstraints): Promise<RetrieverCandidate[]> { return this.candidates; }
  async get_backend_status(): Promise<BackendStatus> {
    return { name: "lexical", available: true };
  }
}

function candidate(memoryId: string, scopeType: ScopeType, score: number, updatedAt: string): RetrieverCandidate {
  return {
    memory_id: memoryId,
    record: {
      memory_id: memoryId,
      title: "Shared conflict memory",
      content: "Shared conflict memory records the project decision.",
      scope_type: scopeType,
      scope_id: `${scopeType}-1`,
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: ReviewState.NotRequired,
      isCurrent: true,
      updated_at: updatedAt,
    },
    score,
    lexical_score: score,
    matched_terms: ["shared", "conflict", "memory"],
    why_matched: ["exact_title"],
    source_retrievers: ["lexical"],
  };
}

function buildRequest(query: string): RecallRequest {
  return {
    query,
    scope_context: {
      user_id: "u-1",
      workspace_id: "w-1",
      project_ids: ["p-1"],
      include_global: true,
      runtime: { run_id: "run-1" }
    },
    limit: 5,
    offset: 0
  };
}

function buildResponse(scope: RecallScopeRef): RecallResponse {
  return {
    results: [
      {
        memory_id: "mem-1",
        title: "Startup context",
        content: "Boot the workspace with recent decisions.",
        scope,
        score: 0.99,
        source_retrievers: ["lexical"],
        matched_terms: ["startup"]
      }
    ],
    filter_mode_applied: FilterMode.Default,
    allowed_scope_set: [scope],
    degraded: false,
    audit_ref: "audit:project_context:startup",
    audit: {
      audit_ref: "audit:project_context:startup",
      query_type: QueryType.ProjectContext,
      strategy: RetrievalStrategy.Hybrid,
      degraded: false,
      degrade_reasons: [],
      lexical_status: { name: "lexical", available: true },
      vector_status: { name: "vector", available: true },
      lexical_hits: 1,
      vector_hits: 0,
      merged_hits: 1,
      returned_hits: 1
    }
  };
}

test("redis recall cache stores startup/search/session/recent entries and invalidates by scope", async () => {
  const client = new FakeRedisClient();
  const cache = new RedisRecallCache({
    config: {
      url: "redis://memory-redis:6379/0",
      prefix: "memory-xx-test",
      connect_timeout_ms: 50,
      empty_recall_ttl_seconds: 15,
      ttl_seconds: { search: 60, session: 60, recent: 60, startup_context: 60 }
    },
    client
  });
  await cache.connect();

  const scope = { type: ScopeType.Project, id: "p-1" };
  const request = buildRequest("startup context for project p-1");
  const response = buildResponse(scope);

  assert.equal((await cache.getSearch(request)), null);
  assert.equal((await cache.getStartupContext(request, {
    query_type: QueryType.ProjectContext,
    confidence: 1,
    strategy_hint: RetrievalStrategy.Hybrid,
    top_k: 5,
    rerank_enabled: true,
    explain_detail: "full",
    reasons: [],
    used_hint: false
  })), null);

  assert.equal((await cache.setSearch(request, response)).status, "stored");
  assert.equal((await cache.setStartupContext(request, {
    query_type: QueryType.ProjectContext,
    confidence: 1,
    strategy_hint: RetrievalStrategy.Hybrid,
    top_k: 5,
    rerank_enabled: true,
    explain_detail: "full",
    reasons: [],
    used_hint: false
  }, response)).status, "stored");
  assert.equal((await cache.rememberSession(request, response)).status, "stored");
  assert.equal((await cache.rememberRecent([scope], response)).status, "stored");

  assert.ok(await cache.getSearch(request));
  assert.ok(await cache.getStartupContext(request, {
    query_type: QueryType.ProjectContext,
    confidence: 1,
    strategy_hint: RetrievalStrategy.Hybrid,
    top_k: 5,
    rerank_enabled: true,
    explain_detail: "full",
    reasons: [],
    used_hint: false
  }));

  await cache.invalidateScopes([scope]);
  assert.equal((await cache.getSearch(request)), null);
  assert.equal((await cache.getStartupContext(request, {
    query_type: QueryType.ProjectContext,
    confidence: 1,
    strategy_hint: RetrievalStrategy.Hybrid,
    top_k: 5,
    rerank_enabled: true,
    explain_detail: "full",
    reasons: [],
    used_hint: false
  })), null);
  await cache.close();
});

test("search cache key changes across embedding generations", () => {
  const request = buildRequest("startup context for project p-1");
  const previousGeneration = process.env.MEMORY_V2_EMBEDDING_GENERATION_ID;
  const previousVersion = process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION;
  try {
    process.env.MEMORY_V2_EMBEDDING_GENERATION_ID = "generation-a";
    process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION = "cache-a";
    const keyA = buildSearchCacheKey("memory-xx-test", request);
    process.env.MEMORY_V2_EMBEDDING_GENERATION_ID = "generation-b";
    process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION = "cache-b";
    const keyB = buildSearchCacheKey("memory-xx-test", request);
    assert.notEqual(keyA, keyB);
  } finally {
    if (previousGeneration === undefined) delete process.env.MEMORY_V2_EMBEDDING_GENERATION_ID;
    else process.env.MEMORY_V2_EMBEDDING_GENERATION_ID = previousGeneration;
    if (previousVersion === undefined) delete process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION;
    else process.env.MEMORY_V2_QUERY_EMBEDDING_CACHE_VERSION = previousVersion;
  }
});

test("redis recall cache probes half-open and recovers after transient failures", async () => {
  const client = new FlakyRedisClient();
  const previous = process.env.MEMORY_V2_REDIS_CACHE_RESET_TIMEOUT_MS;
  const previousMinCalls = process.env.MEMORY_V2_REDIS_CIRCUIT_MIN_CALLS;
  const previousFailureRate = process.env.MEMORY_V2_REDIS_CIRCUIT_FAILURE_RATE;
  process.env.MEMORY_V2_REDIS_CACHE_RESET_TIMEOUT_MS = "50";
  process.env.MEMORY_V2_REDIS_CIRCUIT_MIN_CALLS = "1";
  process.env.MEMORY_V2_REDIS_CIRCUIT_FAILURE_RATE = "0.5";
  const cache = new RedisRecallCache({
    config: {
      url: "redis://memory-redis:6379/0",
      prefix: "memory-xx-test",
      connect_timeout_ms: 50,
      empty_recall_ttl_seconds: 15,
      ttl_seconds: { search: 60, session: 60, recent: 60, startup_context: 60 }
    },
    client
  });
  try {
    await cache.connect();
    assert.equal(await cache.getSearch(buildRequest("startup context")), null);
    let health = await cache.getHealthSnapshot();
    assert.equal(health.circuit_state, "open");
    await new Promise((resolve) => setTimeout(resolve, 60));
    client.failGet = false;
    await cache.setSearch(buildRequest("startup context"), buildResponse({ type: ScopeType.Project, id: "p-1" }));
    health = await cache.getHealthSnapshot();
    assert.equal(health.circuit_state, "closed");
  } finally {
    if (previous === undefined) delete process.env.MEMORY_V2_REDIS_CACHE_RESET_TIMEOUT_MS;
    else process.env.MEMORY_V2_REDIS_CACHE_RESET_TIMEOUT_MS = previous;
    if (previousMinCalls === undefined) delete process.env.MEMORY_V2_REDIS_CIRCUIT_MIN_CALLS;
    else process.env.MEMORY_V2_REDIS_CIRCUIT_MIN_CALLS = previousMinCalls;
    if (previousFailureRate === undefined) delete process.env.MEMORY_V2_REDIS_CIRCUIT_FAILURE_RATE;
    else process.env.MEMORY_V2_REDIS_CIRCUIT_FAILURE_RATE = previousFailureRate;
    await cache.close();
  }
});


test("recall orchestrator surfaces cache hits in audit payload", async () => {
  const scope = { type: ScopeType.Project, id: "p-1" };
  const response = buildResponse(scope);
  const request = buildRequest("startup context for project p-1");
  const cache = {
    async getSearch() { return null; },
    async setSearch() { return { status: "stored" as const }; },
    async getStartupContext() { return { response, key: "startup-key" }; },
    async setStartupContext() { return { status: "stored" as const }; },
    async getSession() { return null; },
    async rememberSession() { return { status: "stored" as const }; },
    async getRecent() { return null; },
    async rememberRecent() { return { status: "stored" as const }; },
    async invalidateScopes() {},
    async getHealthSnapshot() { return {}; },
    async close() {}
  };
  const lexical = new StubLexicalRetriever([]);
  const vector = new StubVectorRetriever({ records: [] });
  const orchestrator = new RecallOrchestrator({ lexical_retriever: lexical, vector_retriever: vector, recall_cache: cache });

  const result = await orchestrator.execute(request);

  assert.equal(result.audit.cache?.startup_context.status, "hit");
  assert.equal(result.audit.cache?.session.status, "stored");
  assert.equal(result.audit.cache?.recent.status, "stored");
  assert.equal(result.results[0]?.memory_id, "mem-1");
});

test("recall orchestrator uses session and recent cache hints inside authorized scopes", async () => {
  const scope = { type: ScopeType.Project, id: "p-1" };
  const request = buildRequest("shared conflict memory");
  const cache = {
    async getSearch() { return null; },
    async setSearch() { return { status: "stored" as const }; },
    async getStartupContext() { return null; },
    async setStartupContext() { return { status: "stored" as const }; },
    async getSession() {
      return {
        key: "session-key",
        entry: { query: request.query, audit_ref: "audit", result_memory_ids: ["mem-1"], cached_at: "2026-05-25T00:00:00.000Z" }
      };
    },
    async rememberSession() { return { status: "stored" as const }; },
    async getRecent(scopes: readonly RecallScopeRef[]) {
      assert.equal(scopes.some((item) => item.type === ScopeType.Project && item.id === "p-1"), true);
      return {
        key: "recent-key",
        entries: [{ memory_id: "mem-1", scope_type: scope.type, scope_id: scope.id, title: "Recent", score: 1, cached_at: "2026-05-25T00:00:00.000Z" }]
      };
    },
    async rememberRecent() { return { status: "stored" as const }; },
    async invalidateScopes() {},
    async getHealthSnapshot() { return {}; },
    async close() {}
  };
  const lexical = new StubLexicalRetriever([candidate("mem-1", ScopeType.Project, 0.5, "2026-05-25T00:00:00.000Z")]);
  const vector = new StubVectorRetriever({ records: [] });
  const orchestrator = new RecallOrchestrator({ lexical_retriever: lexical, vector_retriever: vector, recall_cache: cache });

  const result = await orchestrator.execute(request);

  assert.equal(result.audit.session_cache_hit, true);
  assert.equal(result.audit.recent_cache_hit, true);
  assert.equal(result.results[0]?.source_retrievers?.includes("session_cache"), true);
  assert.equal(result.results[0]?.source_retrievers?.includes("recent_cache"), true);
});

test("recall orchestrator applies scope_conflict_policy to same logical memory", async () => {
  const lexical = new StubLexicalRetriever([
    candidate("global-memory", ScopeType.Global, 0.9, "2026-01-01T00:00:00.000Z"),
    candidate("project-memory", ScopeType.Project, 0.9, "2026-01-02T00:00:00.000Z"),
    candidate("workspace-memory", ScopeType.Workspace, 0.9, "2026-01-03T00:00:00.000Z"),
  ]);
  const vector = new StubVectorRetriever({ records: [] });
  const orchestrator = new RecallOrchestrator({ lexical_retriever: lexical, vector_retriever: vector });

  const higher = await orchestrator.execute({
    ...buildRequest("Shared conflict memory"),
    scope_conflict_policy: "higher_scope_wins",
  });
  assert.equal(higher.results[0]?.memory_id, "global-memory");
  assert.equal(higher.audit.scope_conflict_policy, "higher_scope_wins");

  const specific = await orchestrator.execute({
    ...buildRequest("Shared conflict memory"),
    scope_conflict_policy: "more_specific_wins",
  });
  assert.equal(specific.results[0]?.memory_id, "project-memory");

  const latest = await orchestrator.execute({
    ...buildRequest("Shared conflict memory"),
    scope_conflict_policy: "latest_wins",
  });
  assert.equal(latest.results[0]?.memory_id, "workspace-memory");
});


test("create memory service invalidates scope cache after successful write", async () => {
  const database = new InMemoryWriteDatabase();
  const invalidated: Array<{ type: ScopeType; id: string }> = [];
  const service = new CreateMemoryService({
    database,
    cacheInvalidator: {
      async invalidate(scopes): Promise<void> {
        invalidated.push(...scopes);
      }
    }
  });

  await service.execute({
    requestId: "req-cache-invalidate",
    actorId: "tester",
    scopeType: ScopeType.Project,
    scopeId: "project-alpha",
    content: "Persist memory and invalidate Redis scope caches.",
    title: "Invalidate cache",
    summary: null,
    metadata: {},
    dedupeKey: null,
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.NotRequired,
    sources: [],
    relations: []
  });

  assert.deepEqual(invalidated, [{ type: ScopeType.Project, id: "project-alpha" }]);
});


test("search cache keys diverge when rerank override changes", async () => {
  const client = new FakeRedisClient();
  const cache = new RedisRecallCache({
    config: {
      url: "redis://memory-redis:6379/0",
      prefix: "memory-xx-test",
      connect_timeout_ms: 50,
      empty_recall_ttl_seconds: 15,
      ttl_seconds: { search: 60, session: 60, recent: 60, startup_context: 60 }
    },
    client
  });
  await cache.connect();

  const scope = { type: ScopeType.Project, id: "p-1" };
  const baseRequest = buildRequest("startup context for project p-1");
  const rerankOnRequest: RecallRequest = { ...baseRequest, rerank: true };
  const rerankOffRequest: RecallRequest = { ...baseRequest, rerank: false };

  const onResponse = buildResponse(scope);
  onResponse.audit_ref = "audit:project_context:startup:on";
  const offResponse = buildResponse(scope);
  offResponse.audit_ref = "audit:project_context:startup:off";

  assert.equal((await cache.setSearch(rerankOnRequest, onResponse)).status, "stored");
  assert.equal((await cache.setSearch(rerankOffRequest, offResponse)).status, "stored");

  const cachedOn = await cache.getSearch(rerankOnRequest);
  const cachedOff = await cache.getSearch(rerankOffRequest);

  assert.ok(cachedOn);
  assert.ok(cachedOff);
  assert.notEqual(cachedOn?.key, cachedOff?.key);
  assert.equal(cachedOn?.response.audit_ref, "audit:project_context:startup:on");
  assert.equal(cachedOff?.response.audit_ref, "audit:project_context:startup:off");

  await cache.close();
});

test("session cache key uses explicit session id and scope hash", async () => {
  const client = new FakeRedisClient();
  const cache = new RedisRecallCache({
    config: {
      url: "redis://memory-redis:6379/0",
      prefix: "memory-xx-test",
      connect_timeout_ms: 50,
      empty_recall_ttl_seconds: 15,
      ttl_seconds: { search: 60, session: 60, recent: 60, startup_context: 60 }
    },
    client
  });
  await cache.connect();

  const scope = { type: ScopeType.Project, id: "p-1" };
  const baseRequest = buildRequest("session context");
  const sessionA: RecallRequest = { ...baseRequest, session_id: "session-a" };
  const sessionB: RecallRequest = { ...baseRequest, session_id: "session-b" };
  const scopedB: RecallRequest = {
    ...sessionA,
    scope_context: { ...sessionA.scope_context, project_ids: ["p-2"] }
  };

  assert.equal((await cache.rememberSession(sessionA, buildResponse(scope))).status, "stored");
  assert.equal((await cache.rememberSession(sessionB, buildResponse(scope))).status, "stored");
  assert.equal((await cache.rememberSession(scopedB, buildResponse({ type: ScopeType.Project, id: "p-2" }))).status, "stored");

  const sessionKeys = [...client.store.keys()].filter((key) => key.includes(":cache:session:"));
  assert.equal(sessionKeys.length, 3);
  assert.equal(new Set(sessionKeys).size, 3);

  await cache.close();
});
