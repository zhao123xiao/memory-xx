import assert from "node:assert/strict";
import test from "node:test";

import { mapPostgresRecallRecord } from "../app/recall/retrievers/postgres-support";
import { LifecycleStatus, ReviewState, ScopeType } from "../app/shared";

test("postgres recall mapper preserves cognitive type from metadata", () => {
  const record = mapPostgresRecallRecord({
    id: "m-1",
    scope_type: ScopeType.Project,
    scope_id: "memory-xx",
    content: "Operational issue history",
    title: "issue",
    summary: null,
    metadata: {
      memory_type: "constraint",
      cognitive_type: "episodic",
      recall_policy: "explicit_only",
    },
    lifecycle_status: LifecycleStatus.Approved,
    review_state: ReviewState.Approved,
    is_current: true,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    memory_layer: "recall",
    fact_status: "current",
  });

  assert.equal(record.cognitive_type, "episodic");
  assert.equal(record.recallPolicy, "explicit_only");
});

test("postgres recall mapper reads nested cognitive type from policy metadata", () => {
  const record = mapPostgresRecallRecord({
    id: "m-2",
    scope_type: ScopeType.Project,
    scope_id: "memory-xx",
    content: "Use the deployment rollback runbook when projector sync fails",
    title: "rollback runbook",
    summary: null,
    metadata: {
      memory_type: "procedure",
      memory_policy: {
        cognitive_type: "procedural",
      },
      auto_approval_policy: {
        memory_policy: {
          recall_policy: "default",
        },
      },
    },
    lifecycle_status: LifecycleStatus.Approved,
    review_state: ReviewState.Approved,
    is_current: true,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    memory_layer: "recall",
    fact_status: "current",
  });

  assert.equal(record.cognitive_type, "procedural");
  assert.equal(record.recallPolicy, "default");
});
