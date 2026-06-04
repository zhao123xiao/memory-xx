import test from "node:test";
import assert from "node:assert/strict";

import {
  API_PREFIXES,
  EFFECTIVE_RECALLABLE_EXPRESSION,
  EFFECTIVE_RECALLABLE_PREDICATE,
  EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE,
  FilterMode,
  LifecycleStatus,
  RECALL_API_CONTRACT,
  OutboxEventType,
  OUTBOX_EVENT_TYPES,
  ReviewState,
  ScopeType,
  isEffectiveRecallable
} from "../app/shared";

test("API prefixes stay under /api/memory/xx", () => {
  assert.equal(API_PREFIXES.base, "/api/memory/xx");
  assert.equal(API_PREFIXES.recall, "/api/memory/xx/recall");
  assert.equal(API_PREFIXES.write, "/api/memory/xx/write");
  assert.equal(RECALL_API_CONTRACT.defaultFilterMode, FilterMode.Default);
});

test("effective_recallable helper matches frozen semantics", () => {
  assert.equal(
    isEffectiveRecallable({
      lifecycleStatus: LifecycleStatus.Approved,
      isCurrent: true,
      reviewState: ReviewState.Approved,
      recallPolicy: "test_only"
    }),
    false
  );

  assert.equal(
    isEffectiveRecallable({
      lifecycleStatus: LifecycleStatus.Approved,
      isCurrent: true,
      reviewState: ReviewState.Approved
    }),
    true
  );

  assert.equal(
    isEffectiveRecallable({
      lifecycleStatus: LifecycleStatus.Candidate,
      isCurrent: true,
      reviewState: ReviewState.Pending
    }),
    false
  );

  assert.equal(EFFECTIVE_RECALLABLE_PREDICATE.id, "effective_recallable");
  assert.match(EFFECTIVE_RECALLABLE_EXPRESSION, /lifecycle_status = 'approved'/);
  assert.match(
    EFFECTIVE_RECALLABLE_SQL_WHERE_CLAUSE,
    /review_state IN \('approved', 'silent_approved', 'not_required'\)/
  );
});

test("frozen enums keep Phase A contract values", () => {
  assert.equal(FilterMode.Default, "default");
  assert.equal(ScopeType.Run, "run");
  assert.equal(OutboxEventType.MemoryLifecycleChanged, "memory.lifecycle.changed");
  assert.equal(OUTBOX_EVENT_TYPES.includes(OutboxEventType.ProjectionRebuildRequested), true);
});
