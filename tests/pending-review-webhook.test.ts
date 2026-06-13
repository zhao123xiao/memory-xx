import assert from "node:assert/strict";
import test from "node:test";

import { maybeSendPendingReviewWebhook } from "../app/review/pending-review-webhook";

test("pending review webhook posts summary when configured backlog reaches threshold", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const result = await maybeSendPendingReviewWebhook({
    env: {
      MEMORY_XX_REVIEW_WEBHOOK_URL: "https://review.example/webhook",
      MEMORY_XX_REVIEW_WEBHOOK_THRESHOLD: "2",
    } as NodeJS.ProcessEnv,
    pendingTotal: 3,
    scopeType: "project",
    scopeId: "project-alpha",
    sampleMemoryIds: ["mem-1", "mem-2"],
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response("ok", { status: 200 });
    },
  });

  assert.equal(result.status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://review.example/webhook");
  assert.equal(calls[0]?.body.pending_total, 3);
  assert.equal(calls[0]?.body.scope_type, "project");
  assert.equal(calls[0]?.body.scope_id, "project-alpha");
  assert.deepEqual(calls[0]?.body.sample_memory_ids, ["mem-1", "mem-2"]);
});

test("pending review webhook is skipped when unconfigured or below threshold", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("unexpected", { status: 500 });
  };

  assert.equal((await maybeSendPendingReviewWebhook({
    env: {} as NodeJS.ProcessEnv,
    pendingTotal: 30,
    scopeType: "project",
    scopeId: "project-alpha",
    sampleMemoryIds: [],
    fetchImpl,
  })).status, "not_configured");

  assert.equal((await maybeSendPendingReviewWebhook({
    env: {
      MEMORY_XX_REVIEW_WEBHOOK_URL: "https://review.example/webhook",
      MEMORY_XX_REVIEW_WEBHOOK_THRESHOLD: "20",
    } as NodeJS.ProcessEnv,
    pendingTotal: 19,
    scopeType: "project",
    scopeId: "project-alpha",
    sampleMemoryIds: [],
    fetchImpl,
  })).status, "below_threshold");

  assert.equal(calls, 0);
});

test("pending review webhook reports failed notification without throwing", async () => {
  const result = await maybeSendPendingReviewWebhook({
    env: {
      MEMORY_XX_REVIEW_WEBHOOK_URL: "https://review.example/webhook",
      MEMORY_XX_REVIEW_WEBHOOK_THRESHOLD: "1",
    } as NodeJS.ProcessEnv,
    pendingTotal: 2,
    scopeType: null,
    scopeId: null,
    sampleMemoryIds: ["mem-1"],
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.httpStatus, 503);
});
