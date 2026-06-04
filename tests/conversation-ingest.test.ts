import test from "node:test";
import assert from "node:assert/strict";

import { requiredPermissionForPath } from "../app/server/http-server";
import { createTestHarness, request } from "./http-test-harness";

test("conversation routes require write permission", () => {
  assert.equal(requiredPermissionForPath("/api/memory/xx/conversation/events"), "memory:write");
  assert.equal(requiredPermissionForPath("/api/memory/xx/conversation/ingest"), "memory:write");
  assert.equal(requiredPermissionForPath("/api/memory/xx/conversation/flush"), "memory:write");
});

test("conversation ingest validates messages before extraction", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/conversation/ingest", {
      method: "POST",
      body: {
        conversation_id: "conv-test",
        session_id: "session-test",
        scope_context: { project_ids: ["project-a"] },
        messages: [],
      },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error?: string }).error, "messages_required");
    assert.deepEqual((res.body as { expected?: unknown }).expected, {
      messages: [{ role: "user", content: "..." }],
    });
  } finally {
    await harness.close();
  }
});

test("conversation events endpoint is wired and reports unavailable runtime cleanly", async () => {
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/conversation/events", {
      method: "POST",
      body: {
        conversation_id: "conv-test",
        session_id: "session-test",
        scope_context: { project_ids: ["project-a"] },
        event: {
          turn_id: "turn-1",
          role: "user",
          content: "我以后更偏好先给实现计划再执行。",
        },
      },
    });
    assert.equal(res.status, 503);
    assert.equal((res.body as { ok?: boolean }).ok, false);
    assert.match(String((res.body as { error?: string }).error), /运行时尚未初始化|Runtime not yet initialised|postgres_required/u);
  } finally {
    await harness.close();
  }
});

test("conversation ingest strict scope rejects missing long-term scope", async () => {
  const previous = process.env.MEMORY_XX_CONVERSATION_STRICT_SCOPE;
  process.env.MEMORY_XX_CONVERSATION_STRICT_SCOPE = "1";
  const harness = await createTestHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/conversation/ingest", {
      method: "POST",
      body: {
        conversation_id: "conv-test",
        session_id: "session-test",
        messages: [{ role: "user", content: "请记住：没有 scope 时 strict 模式要拒绝。" }],
      },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error?: string }).error, "scope_context_required");
  } finally {
    await harness.close();
    if (previous === undefined) delete process.env.MEMORY_XX_CONVERSATION_STRICT_SCOPE;
    else process.env.MEMORY_XX_CONVERSATION_STRICT_SCOPE = previous;
  }
});
