import assert from "node:assert/strict";
import test from "node:test";

import { buildRecallRequestFromBody } from "../app/server/http-handlers";

test("legacy recall request respects explicit project scope without default widening", () => {
  const request = buildRecallRequestFromBody({
    query: "project alpha fact",
    scope_context: {
      project_ids: ["project-alpha"],
      include_global: false,
    },
  });

  assert.deepEqual(request.scope_context.project_ids, ["project-alpha"]);
  assert.equal(request.scope_context.include_global, false);
  assert.equal(request.scope_context.user_id, undefined);
  assert.equal(request.scope_context.workspace_id, undefined);
  assert.equal(request.debug?.scope_context_source, "caller_explicit");
  assert.equal(request.debug?.default_scope_injected, false);
});

test("legacy recall request injects default long-term scope only when caller omitted it", () => {
  const request = buildRecallRequestFromBody({ query: "status memory" });

  assert.equal(request.scope_context.user_id, "current-instance-owner");
  assert.equal(request.scope_context.workspace_id, "current-instance");
  assert.equal(request.scope_context.include_global, true);
  assert.equal(request.debug?.scope_context_source, "defaulted");
  assert.equal(request.debug?.default_scope_injected, true);
});

test("legacy recall request treats memory_ids as explicit exact-memory scope", () => {
  const request = buildRecallRequestFromBody({
    query: "exact memory",
    memory_ids: ["memory_record_123"],
  });

  assert.deepEqual(request.scope_context.memory_ids, ["memory_record_123"]);
  assert.equal(request.scope_context.user_id, undefined);
  assert.equal(request.scope_context.workspace_id, undefined);
  assert.equal(request.scope_context.include_global, false);
  assert.equal(request.debug?.scope_context_source, "caller_explicit");
});
