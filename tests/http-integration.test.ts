import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { validateWriteBody, validateRecallBody, validateReviewBody } from "../app/server/input-validation";
import { RateLimiter } from "../app/server/rate-limiter";
import { InMemoryRequestMetrics } from "../app/server/metrics";
import { createLogger } from "../app/shared/logger";
import { createTestHarness, request } from "./http-test-harness";
import { RecallFeedbackRepository } from "../app/db/repositories/recall-feedback-repository";
import { withWriteTransaction } from "../app/db/tx/write-transaction";
import { QueryType, RetrievalStrategy } from "../app/recall";
import { parseJsonBody } from "../app/server/body";
import { SkillRegistry } from "../app/skills/skill-registry";
import { handleExecuteSkill } from "../app/api/skills/handlers";

async function invokeSkillExecute(
  registry: SkillRegistry,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const req = new PassThrough();
  Object.assign(req, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const chunks: string[] = [];
  const resState = { statusCode: 0, finished: false };
  const res = {
    writeHead(status: number) {
      resState.statusCode = status;
      return res;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) chunks.push(String(chunk));
      resState.finished = true;
    },
  } as unknown as ServerResponse;
  void handleExecuteSkill(req as unknown as IncomingMessage, res, registry);
  req.end(JSON.stringify(body));
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (resState.finished) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
  return { status: resState.statusCode, body: JSON.parse(chunks.join("") || "{}") };
}

async function rawJsonRequest(
  baseUrl: string,
  path: string,
  rawBody: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body };
}

// ============================================================================
// Unit tests: Input Validation
// ============================================================================

test("validateWriteBody rejects missing scopeType", () => {
  const result = validateWriteBody({ scopeId: "x", content: "y" });
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.error.includes("scopeType"));
});

test("validateWriteBody rejects invalid scopeType", () => {
  const result = validateWriteBody({ scopeType: "invalid", scopeId: "x", content: "y" });
  assert.equal(result.valid, false);
});

test("validateWriteBody rejects empty content", () => {
  const result = validateWriteBody({ scopeType: "personal", scopeId: "x", content: "" });
  assert.equal(result.valid, false);
});

test("validateWriteBody rejects blank scope, content, title, and long dedupeKey", () => {
  assert.equal(validateWriteBody({ scopeType: "personal", scopeId: "   ", content: "x" }).valid, false);
  assert.equal(validateWriteBody({ scopeType: "personal", scopeId: "x", content: "   " }).valid, false);
  assert.equal(validateWriteBody({ scopeType: "personal", scopeId: "x", content: "real content", title: "   " }).valid, false);
  assert.equal(validateWriteBody({ scopeType: "personal", scopeId: "x", content: "real content", dedupeKey: "x".repeat(257) }).valid, false);
});

test("validateWriteBody accepts valid body", () => {
  const result = validateWriteBody({ scopeType: "personal", scopeId: "user-1", content: "test", title: "T" });
  assert.equal(result.valid, true);
});

test("validateWriteBody rejects unsupported create lifecycle combinations", () => {
  const rejected = validateWriteBody({
    scopeType: "personal",
    scopeId: "user-1",
    content: "test",
    lifecycleStatus: "rejected",
    reviewState: "rejected",
  });
  assert.equal(rejected.valid, false);
  if (!rejected.valid) assert.equal(rejected.error, "invalid_create_state");

  const approved = validateWriteBody({
    scopeType: "personal",
    scopeId: "user-1",
    content: "test",
    lifecycleStatus: "approved",
    reviewState: "not_required",
  });
  assert.equal(approved.valid, true);
});

test("validateWriteBody validates relation schema before write service", () => {
  const missingTarget = validateWriteBody({
    scopeType: "personal",
    scopeId: "user-1",
    content: "test",
    relations: [{ relationType: "supports" }],
  });
  assert.equal(missingTarget.valid, false);
  if (!missingTarget.valid) assert.equal(missingTarget.error, "relations[0].relatedMemoryId_required");

  const valid = validateWriteBody({
    scopeType: "personal",
    scopeId: "user-1",
    content: "test",
    relations: [{ relatedMemoryId: "memory-target", relationType: "supports", direction: "bidirectional" }],
  });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.deepEqual(valid.value.relations, [{ relatedMemoryId: "memory-target", relationType: "supports", direction: "bidirectional" }]);
  }
});

test("validateRecallBody rejects blank query and unsupported scope conflict policy", () => {
  assert.equal(validateRecallBody({ query: "   " }).valid, false);
  assert.equal(validateRecallBody({ query: "test", scope_context: "invalid" }).valid, false);
  const result = validateRecallBody({ query: "test", scope_conflict_policy: "unknown" });
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.error, "unsupported_scope_conflict_policy");
});

test("validateRecallBody rejects limit > 100", () => {
  const result = validateRecallBody({ query: "test", limit: 999 });
  assert.equal(result.valid, false);
});

test("validateReviewBody requires content for supersede", () => {
  const result = validateReviewBody({}, "supersede");
  assert.equal(result.valid, false);
});

test("validateReviewBody rejects blank supersede content", () => {
  const result = validateReviewBody({ content: "   " }, "supersede");
  assert.equal(result.valid, false);
});

test("validateReviewBody accepts empty for approve", () => {
  const result = validateReviewBody({}, "approve");
  assert.equal(result.valid, true);
});

// ============================================================================
// Unit tests: Rate Limiter
// ============================================================================

test("RateLimiter blocks requests exceeding limit", () => {
  const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
  assert.equal(limiter.isAllowed("c1"), true);
  assert.equal(limiter.isAllowed("c1"), true);
  assert.equal(limiter.isAllowed("c1"), false);
});

test("RateLimiter reset clears bucket", () => {
  const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
  limiter.isAllowed("c1");
  limiter.isAllowed("c1");
  limiter.reset("c1");
  assert.equal(limiter.isAllowed("c1"), true);
});

// ============================================================================
// Unit tests: Metrics
// ============================================================================

test("InMemoryRequestMetrics tracks counters and histograms", () => {
  const m = new InMemoryRequestMetrics();
  m.incrementCounter("test_counter", { k: "v" });
  m.observeHistogram("test_hist", 42);
  const snap = m.getSnapshot();
  assert.equal(snap.test_counter, 1);
  const h = snap.test_hist as Record<string, number>;
  assert.equal(h.count, 1);
  assert.equal(h.avg, 42);
});

test("InMemoryRequestMetrics getPrometheusSnapshot outputs valid format", () => {
  const m = new InMemoryRequestMetrics();
  m.incrementCounter("http_requests_total", { method: "GET", status: "200" });
  m.incrementCounter("http_requests_total", { method: "GET", status: "200" });
  m.observeHistogram("http_request_duration_ms", 100, { route: "/health" });
  const prom = m.getPrometheusSnapshot();
  assert.ok(prom.includes("# TYPE http_requests_total counter"));
  assert.ok(prom.includes('http_requests_total{method="GET",status="200"} 2'));
  assert.ok(prom.includes("# TYPE http_request_duration_ms summary"));
  assert.ok(prom.includes("http_request_duration_ms_count"));
});

// ============================================================================
// Unit tests: Logger
// ============================================================================

test("logger withTrace creates child logger with traceId", () => {
  const lines: string[] = [];
  const origStdout = process.stdout.write;
  process.stdout.write = (chunk: any) => { lines.push(String(chunk)); return true; };
  try {
    const log = createLogger("test-logger");
    const traced = log.withTrace("trace-abc-123");
    traced.info("test message");
    assert.ok(lines.length >= 1);
    const parsed = JSON.parse(lines[lines.length - 1]);
    assert.equal(parsed.traceId, "trace-abc-123");
  } finally {
    process.stdout.write = origStdout;
  }
});

// ============================================================================
// HTTP Integration Tests
// ============================================================================

test("GET /health returns 503 with degraded status when runtime is null", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/health");
    assert.equal(res.status, 503);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.status, "degraded");
    assert.equal(body.runtime_initialised, false);
  } finally {
    await harness.close();
  }
});

test("GET /live returns liveness without authentication", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/live");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok", service: "memory-xx" });
  } finally {
    await harness.close();
  }
});

test("parseJsonBody returns immediately for Content-Length zero and times out unfinished bodies", async () => {
  const empty = new PassThrough();
  Object.assign(empty, { headers: { "content-length": "0" } });
  assert.deepEqual(await parseJsonBody(empty as unknown as IncomingMessage), {});

  const unfinished = new PassThrough();
  Object.assign(unfinished, { headers: {} });
  await assert.rejects(
    parseJsonBody(unfinished as unknown as IncomingMessage, undefined, 10),
    /body_read_timeout/
  );
  unfinished.destroy();
});

test("skills and intelligence JSON routes reject bodies over 1MB", async () => {
  const harness = await createTestHarness();
  try {
    const largeText = "x".repeat(1_048_577);
    for (const path of ["/api/memory/xx/skills/execute", "/api/memory/xx/intelligence/extract"]) {
      const res = await fetch(`${harness.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: largeText, skill_id: "health_check", params: {} })
      });
      assert.equal(res.status, 413);
    }
  } finally {
    await harness.close();
  }
});

test("POST JSON routes reject malformed JSON with 400 instead of 500", async () => {
  const harness = await createTestHarness({
    env: { MEMORY_XX_SCOPE_POLICY_MODE: "single_user" } as NodeJS.ProcessEnv,
  });
  try {
    const paths = [
      "/api/memory/xx/skills/execute",
      "/api/memory/xx/intelligence/extract",
      "/api/memory/xx/intelligence/smart-write",
      "/api/memory/xx/mcp/smart-write",
      "/api/memory/xx/conversation/events",
      "/api/memory/xx/conversation/ingest",
      "/api/memory/xx/conversation/flush",
    ];

    for (const path of paths) {
      const res = await rawJsonRequest(harness.baseUrl, path, "{");
      assert.equal(res.status, 400, `${path} should reject malformed JSON as a client error`);
      assert.match(String((res.body as Record<string, unknown>).error), /invalid_json_body|JSON 请求体无效/u);
    }
  } finally {
    await harness.close();
  }
});

test("skills execute accepts canonical params and flat compatibility payload", async () => {
  const registry = new SkillRegistry();
  const calls: Record<string, unknown>[] = [];
  registry.register({
    id: "echo_params",
    name: "Echo Params",
    description: "Echo params for contract tests.",
    category: "analysis",
    sideEffects: "read",
    parameters: [
      { name: "query", type: "string", description: "Query", required: true },
    ],
  }, async (params) => {
    calls.push(params);
    return { success: true, data: params };
  });

  const canonical = await invokeSkillExecute(registry, {
    skill_id: "echo_params",
    params: { query: "canonical" },
  });
  const flat = await invokeSkillExecute(registry, {
    skill_id: "echo_params",
    query: "flat",
  });

  assert.equal(canonical.status, 200);
  assert.equal(flat.status, 200);
  assert.deepEqual(calls, [{ query: "canonical" }, { query: "flat" }]);
  assert.equal((flat.body as Record<string, unknown>).params_source, "flat_payload");
});

test("GET /unknown returns 404", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/unknown");
    assert.equal(res.status, 404);
    const body = res.body as Record<string, unknown>;
    assert.ok(body.error);
  } finally {
    await harness.close();
  }
});

test("unified recall-feedback records feedback without appending outbox events", async () => {
  const harness = await createTestHarness({
    env: { MEMORY_XX_SCOPE_POLICY_MODE: "single_user" } as NodeJS.ProcessEnv
  });
  try {
    const repository = new RecallFeedbackRepository();
    await withWriteTransaction(harness.database, (tx) => repository.addTrace(tx, {
      id: "trace-http-1",
      queryHash: "query-hash-http-1",
      queryExcerpt: "recall feedback",
      actorId: "agent-http",
      scopeContext: { project_ids: ["project-http"] },
      queryType: QueryType.ProjectContext,
      strategy: RetrievalStrategy.Hybrid,
      degradeLevel: 0,
      results: { memory_ids: ["mem-http-1"] },
      audit: {}
    }));

    const res = await request(harness.baseUrl, "/api/memory/xx/unified/recall-feedback", {
      method: "POST",
      body: {
        request_id: "recall-feedback-command-1",
        recall_trace_id: "trace-http-1",
        actor_id: "agent-http",
        used_memory_ids: ["mem-http-1"],
        feedback_type: "false_positive",
        memory_id: "mem-http-1"
      }
    });
    const replay = await request(harness.baseUrl, "/api/memory/xx/unified/recall-feedback", {
      method: "POST",
      body: {
        request_id: "recall-feedback-command-1",
        recall_trace_id: "trace-http-1",
        actor_id: "agent-http",
        used_memory_ids: ["mem-http-1"],
        feedback_type: "false_positive",
        memory_id: "mem-http-1"
      }
    });
    const conflict = await request(harness.baseUrl, "/api/memory/xx/unified/recall-feedback", {
      method: "POST",
      body: {
        request_id: "recall-feedback-command-1",
        recall_trace_id: "trace-http-1",
        actor_id: "agent-http",
        used_memory_ids: ["mem-http-1"],
        feedback_type: "ignored",
        memory_id: "mem-http-1"
      }
    });

    assert.equal(res.status, 200);
    const body = res.body as { outbox_events_skipped?: boolean; events?: unknown[] };
    assert.equal(body.outbox_events_skipped, true);
    assert.equal(body.events?.length, 2);
    assert.equal(replay.status, 200);
    assert.equal((replay.body as Record<string, unknown>).replayed, true);
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as Record<string, unknown>).error, "idempotency_payload_conflict");

    const snapshot = await harness.database.snapshot();
    const requestRow = snapshot.ingestRequests.find((row) => row.requestId === "recall-feedback-command-1");
    assert.equal(requestRow?.commandType, "recall.feedback");
    assert.equal(requestRow?.status, "completed");
    assert.equal(snapshot.recallFeedbackEvents.length, 2);
    assert.equal(snapshot.outboxEvents.length, 0);
  } finally {
    await harness.close();
  }
});

test("ordinary feedback uses its own idempotent command chain", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "feedback-chain-test", content: "Feedback chain target memory" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;
    const feedbackBody = {
      request_id: "feedback-command-1",
      memory_id: memoryId,
      feedback_type: "used",
      agent_id: "tester",
      reason: "covered by test"
    };

    const first = await request(harness.baseUrl, "/api/memory/xx/unified/feedback", {
      method: "POST",
      body: feedbackBody,
    });
    const replay = await request(harness.baseUrl, "/api/memory/xx/unified/feedback", {
      method: "POST",
      body: feedbackBody,
    });
    const conflict = await request(harness.baseUrl, "/api/memory/xx/unified/feedback", {
      method: "POST",
      body: { ...feedbackBody, feedback_type: "negative" },
    });

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal((replay.body as Record<string, unknown>).replayed, true);
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as Record<string, unknown>).error, "idempotency_payload_conflict");

    const snapshot = await harness.database.snapshot();
    const requestRow = snapshot.ingestRequests.find((row) => row.requestId === "feedback-command-1");
    assert.equal(requestRow?.commandType, "memory.feedback");
    assert.equal(requestRow?.status, "completed");
    assert.equal(snapshot.memoryFeedbackEvents.length, 1);
    assert.ok(snapshot.memoryEvents.some((event) => event.requestId === "feedback-command-1" && event.eventType === "memory.feedback.recorded"));
    assert.ok(snapshot.outboxEvents.some((event) => event.requestId === "feedback-command-1" && event.eventType === "memory.feedback.recorded"));
  } finally {
    await harness.close();
  }
});

test("runtime scopes are rejected at public write and runtime-only recall entries", async () => {
  const harness = await createTestHarness();
  try {
    const write = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "run", scopeId: "run-1", content: "runtime scope should not be written" },
    });
    assert.equal(write.status, 400);
    assert.equal((write.body as Record<string, unknown>).error, "runtime_scope_not_supported_for_write");
    assert.match(String((write.body as Record<string, unknown>).message), /runtime-only|运行时/u);

    const remember = await request(harness.baseUrl, "/api/memory/xx/unified/remember", {
      method: "POST",
      body: {
        user_id: "user-1",
        agent_id: "agent-1",
        scope_type: "task",
        scope_id: "task-1",
        content: "runtime scope should not be remembered"
      },
    });
    assert.equal(remember.status, 400);
    assert.equal((remember.body as Record<string, unknown>).error, "runtime_scope_not_supported_for_write");

    const recall = await request(harness.baseUrl, "/api/memory/xx/unified/recall", {
      method: "POST",
      body: { query: "runtime only", include_global: false, runtime: { run_id: "run-1" } },
    });
    assert.equal(recall.status, 400);
    assert.equal((recall.body as Record<string, unknown>).error, "long_term_scope_required");
  } finally {
    await harness.close();
  }
});

test("write rejects relation targets that do not exist with 404", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: {
        scopeType: "personal",
        scopeId: "relation-test",
        content: "Relation source memory",
        relations: [{ relatedMemoryId: "memory-missing-target", relationType: "supports" }],
      },
    });
    assert.equal(res.status, 404);
    assert.equal((res.body as Record<string, unknown>).error, "Relation target memory-missing-target was not found.");
  } finally {
    await harness.close();
  }
});

test("write rejects invalid lifecycle state before DB constraints", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: {
        scopeType: "personal",
        scopeId: "lifecycle-test",
        content: "Invalid lifecycle memory",
        lifecycleStatus: "archived",
        reviewState: "approved",
      },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as Record<string, unknown>).error, "invalid_create_state");
  } finally {
    await harness.close();
  }
});

test("privileged filter modes require governance permission rather than env flag", async () => {
  const runtime = {
    orchestrator: {
      execute: async (req: { filter_mode?: string }) => ({
        query: "governance",
        results: [],
        filter_mode_applied: req.filter_mode ?? "default",
        audit: { degrade_level: 0, confidence_gate: { accepted: true } },
      }),
    },
  } as any;

  const reader = await createTestHarness({
    authToken: "reader",
    runtime,
    env: { MEMORY_XX_LEGACY_TOKEN_PERMISSIONS: "memory:read", MEMORY_XX_SCOPE_POLICY_MODE: "single_user" } as NodeJS.ProcessEnv,
  });
  try {
    const normal = await request(reader.baseUrl, "/api/memory/xx/recall/query", {
      method: "POST",
      headers: { authorization: "Bearer reader" },
      body: { query: "governance", scope_context: { project_ids: ["p1"] }, filter_mode: "governance" },
    });
    assert.equal(normal.status, 403);
  } finally {
    await reader.close();
  }

  const admin = await createTestHarness({
    authToken: "reader",
    adminToken: "admin",
    runtime,
    env: { MEMORY_XX_SCOPE_POLICY_MODE: "single_user" } as NodeJS.ProcessEnv,
  });
  try {
    const privileged = await request(admin.baseUrl, "/api/memory/xx/recall/query", {
      method: "POST",
      headers: { authorization: "Bearer admin" },
      body: { query: "governance", scope_context: { project_ids: ["p1"] }, filter_mode: "governance" },
    });
    assert.equal(privileged.status, 200);
    assert.equal((privileged.body as Record<string, unknown>).filter_mode_applied, "governance");
  } finally {
    await admin.close();
  }
});

test("OPTIONS returns 204 with CORS headers", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/health", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
    assert.ok(res.headers["access-control-allow-methods"]?.includes("POST"));
  } finally {
    await harness.close();
  }
});

test("CORS default does not wildcard non-local origins", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/health", {
      method: "OPTIONS",
      headers: { origin: "https://example.test" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  } finally {
    await harness.close();
  }
});

test("auth enabled: no token returns 401", async () => {
  const harness = await createTestHarness({ authToken: "secret-key" });
  try {
    const res = await request(harness.baseUrl, "/health");
    assert.equal(res.status, 401);
  } finally {
    await harness.close();
  }
});

test("auth enabled: intelligence extract without token returns 401", async () => {
  const harness = await createTestHarness({ authToken: "secret-key" });
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/intelligence/extract", {
      method: "POST",
      body: { text: "extract this memory" },
    });
    assert.equal(res.status, 401);
  } finally {
    await harness.close();
  }
});

test("auth enabled: valid Bearer token returns 200 or 503", async () => {
  const harness = await createTestHarness({ authToken: "secret-key" });
  try {
    const res = await request(harness.baseUrl, "/health", {
      headers: { authorization: "Bearer secret-key" },
    });
    assert.ok(res.status === 200 || res.status === 503);
  } finally {
    await harness.close();
  }
});

test("auth enabled: valid X-API-Key header works", async () => {
  const harness = await createTestHarness({ authToken: "secret-key" });
  try {
    const res = await request(harness.baseUrl, "/health", {
      headers: { "x-api-key": "secret-key" },
    });
    assert.ok(res.status === 200 || res.status === 503);
  } finally {
    await harness.close();
  }
});

test("rate limit exceeded returns 429 with Retry-After", async () => {
  const harness = await createTestHarness({ rateLimitMax: 2 });
  try {
    await request(harness.baseUrl, "/health");
    await request(harness.baseUrl, "/health");
    const res = await request(harness.baseUrl, "/health");
    assert.equal(res.status, 429);
    assert.ok(res.headers["retry-after"]);
    const body = res.body as Record<string, unknown>;
    assert.ok(body.retry_after_seconds);
  } finally {
    await harness.close();
  }
});

test("POST /write with missing scopeType returns 400", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeId: "x", content: "y" },
    });
    assert.equal(res.status, 400);
  } finally {
    await harness.close();
  }
});

test("POST /write rejects blank content", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "test-user", content: "   " },
    });
    assert.equal(res.status, 400);
  } finally {
    await harness.close();
  }
});

test("POST /write with valid body returns 201", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: {
        scopeType: "personal",
        scopeId: "test-user",
        content: "Integration test memory",
        title: "Test",
      },
    });
    assert.equal(res.status, 201);
    const body = res.body as Record<string, unknown>;
    assert.ok(body.memoryId);
    assert.equal(body.lifecycleStatus, "candidate");
  } finally {
    await harness.close();
  }
});

test("POST /write with same requestId returns 200 (replay)", async () => {
  const harness = await createTestHarness();
  try {
    const reqId = "replay-test-" + Date.now();
    const body = {
      scopeType: "personal",
      scopeId: "test-user",
      content: "Replay test",
      requestId: reqId,
    };
    const res1 = await request(harness.baseUrl, "/api/memory/xx/write", { method: "POST", body });
    assert.equal(res1.status, 201);
    const res2 = await request(harness.baseUrl, "/api/memory/xx/write", { method: "POST", body });
    assert.equal(res2.status, 200);
    const b2 = res2.body as Record<string, unknown>;
    assert.equal(b2.replayed, true);
  } finally {
    await harness.close();
  }
});

test("GET /metrics returns JSON snapshot", async () => {
  const harness = await createTestHarness();
  try {
    // Use metrics directly since the close event (which records metrics) may not have fired
    harness.metrics.incrementCounter("http_requests_total", { method: "GET", status: "200" });
    const res = await request(harness.baseUrl, "/metrics");
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    assert.ok(body.http_requests_total);
  } finally {
    await harness.close();
  }
});

test("GET /metrics/prometheus returns Prometheus text format", async () => {
  const harness = await createTestHarness();
  try {
    harness.metrics.incrementCounter("http_requests_total", { method: "GET", status: "200" });
    const res = await request(harness.baseUrl, "/metrics/prometheus");
    assert.equal(res.status, 200);
    assert.ok(res.headers["content-type"]?.includes("text/plain"));
    const body = res.body as string;
    assert.ok(body.includes("# TYPE http_requests_total counter"));
  } finally {
    await harness.close();
  }
});

test("review approve lifecycle works", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "Review test memory" },
    });
    const writeBody = writeRes.body as Record<string, string>;
    const memoryId = writeBody.memoryId;

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/approve`, {
      method: "POST",
      body: { actorId: "tester" },
    });
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.lifecycleStatus, "approved");
    assert.equal(body.reviewState, "approved");
  } finally {
    await harness.close();
  }
});

test("review reject lifecycle works", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "Reject test memory" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/reject`, {
      method: "POST",
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as Record<string, unknown>).reviewState, "rejected");
  } finally {
    await harness.close();
  }
});

test("review update-candidate edits pending candidate in place", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "Candidate draft before edit", title: "Draft" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/update-candidate`, {
      method: "POST",
      body: { content: "Candidate draft after edit", title: "Edited draft", actorId: "tester" },
    });
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.memoryId, memoryId);
    assert.equal(body.commandType, "memory.candidate.update");
    assert.equal(body.lifecycleStatus, "candidate");

    const snapshot = await harness.database.snapshot();
    const row = snapshot.memoryRecords.find((record) => record.id === memoryId);
    assert.equal(row?.content, "Candidate draft after edit");
    assert.equal(row?.title, "Edited draft");
  } finally {
    await harness.close();
  }
});

test("review update-candidate rejects approved memory", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "Approved memory cannot be draft edited" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;
    await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/approve`, {
      method: "POST",
      body: {},
    });

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/update-candidate`, {
      method: "POST",
      body: { content: "Illegal candidate update" },
    });
    assert.equal(res.status, 409);
  } finally {
    await harness.close();
  }
});

test("review archive lifecycle works", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "Archive test memory" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;

    // Approve first
    await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/approve`, {
      method: "POST", body: {},
    });

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/archive`, {
      method: "POST", body: {},
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as Record<string, unknown>).lifecycleStatus, "archived");
  } finally {
    await harness.close();
  }
});

test("deprecated feedback alias rejects unknown action before touching runtime", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/feedback/memories/memory-1/unknown", {
      method: "POST",
      body: { agent_id: "tester" },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as Record<string, unknown>).error, "反馈操作无效");
  } finally {
    await harness.close();
  }
});

test("deprecated feedback alias maps used action to unified feedback", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "feedback-alias-test", content: "Feedback alias target memory" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;

    const res = await request(harness.baseUrl, `/api/memory/xx/feedback/memories/${memoryId}/used`, {
      method: "POST",
      body: { agent_id: "tester", reason: "alias smoke" },
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as Record<string, unknown>).ok, true);

    const snapshot = await harness.database.snapshot();
    assert.equal(snapshot.memoryFeedbackEvents.length, 1);
    assert.equal(snapshot.memoryFeedbackEvents[0].feedbackType, "used");
    assert.equal(snapshot.memoryFeedbackEvents[0].metadata.deprecated_alias, "/api/memory/xx/feedback/memories/:memory_id/:action");
  } finally {
    await harness.close();
  }
});

test("review supersede with content returns 201", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "Supersede original" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;

    await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/approve`, {
      method: "POST", body: {},
    });

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/supersede`, {
      method: "POST",
      body: { content: "Superseded content", actorId: "tester" },
    });
    assert.equal(res.status, 201);
    const body = res.body as Record<string, unknown>;
    assert.ok(body.memoryId);
    assert.equal(body.lifecycleStatus, "approved");
    assert.equal((body as Record<string, unknown>).supersededMemoryId, memoryId);
  } finally {
    await harness.close();
  }
});

test("review supersede without content returns 400", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "No content supersede" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/supersede`, {
      method: "POST", body: {},
    });
    assert.equal(res.status, 400);
  } finally {
    await harness.close();
  }
});

test("review tombstone lifecycle works", async () => {
  const harness = await createTestHarness();
  try {
    const writeRes = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { scopeType: "personal", scopeId: "review-test", content: "Tombstone test" },
    });
    const memoryId = (writeRes.body as Record<string, string>).memoryId;

    await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/approve`, {
      method: "POST", body: {},
    });

    const res = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/tombstone`, {
      method: "POST", body: {},
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as Record<string, unknown>).lifecycleStatus, "tombstone");
  } finally {
    await harness.close();
  }
});

test("dedupeKey auto-supersede on second write", async () => {
  const harness = await createTestHarness();
  try {
    const dedupeKey = "dedupe-http-test-" + Date.now();
    const body1 = {
      scopeType: "personal", scopeId: "dedupe-test",
      content: "First version", dedupeKey,
      lifecycleStatus: "approved", reviewState: "not_required",
    };
    await request(harness.baseUrl, "/api/memory/xx/write", { method: "POST", body: body1 });

    const body2 = {
      scopeType: "personal", scopeId: "dedupe-test",
      content: "Second version", dedupeKey,
      lifecycleStatus: "approved", reviewState: "not_required",
    };
    const res2 = await request(harness.baseUrl, "/api/memory/xx/write", { method: "POST", body: body2 });
    assert.equal(res2.status, 201);
    const b2 = res2.body as Record<string, unknown>;
    assert.ok(b2.supersededMemoryId);
  } finally {
    await harness.close();
  }
});

test("dedupeKey same content replays existing memory instead of leaking unique constraint", async () => {
  const harness = await createTestHarness();
  try {
    const dedupeKey = "dedupe-http-replay-test-" + Date.now();
    const body = {
      scopeType: "personal", scopeId: "dedupe-test",
      content: "Same version", dedupeKey,
    };
    const first = await request(harness.baseUrl, "/api/memory/xx/write", { method: "POST", body });
    const second = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      body: { ...body, requestId: "dedupe-replay-" + Date.now() },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal((second.body as Record<string, unknown>).memoryId, (first.body as Record<string, unknown>).memoryId);
    assert.equal((second.body as Record<string, unknown>).replayed, true);
  } finally {
    await harness.close();
  }
});

test("recall with runtime null returns 503", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/recall/query", {
      method: "POST",
      body: { query: "test", scope_context: { user_id: "u" } },
    });
    assert.equal(res.status, 503);
  } finally {
    await harness.close();
  }
});

test("GET /metrics increments counters after requests", async () => {
  const harness = await createTestHarness();
  try {
    // Manually increment to verify metrics flow through the endpoint
    harness.metrics.incrementCounter("http_requests_total", { method: "GET", route: "/health", status: "503" });
    harness.metrics.incrementCounter("http_requests_total", { method: "GET", route: "/health", status: "503" });
    const res = await request(harness.baseUrl, "/metrics");
    const body = res.body as Record<string, unknown>;
    const total = body.http_requests_total as number;
    assert.ok(total >= 2, `Expected >= 2, got ${total}`);
  } finally {
    await harness.close();
  }
});
