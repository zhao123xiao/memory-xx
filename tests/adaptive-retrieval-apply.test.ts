import assert from "node:assert/strict";
import test from "node:test";

import {
  executeAdaptiveRetrievalThresholdPlan,
  stableAdaptiveRetrievalSelectorHash,
} from "../app/governance/adaptive-retrieval-apply";
import { InMemoryWriteDatabase } from "../app/db";
import type { AdaptiveRetrievalApplyPlan } from "../app/governance/adaptive-retrieval-calibration";

const now = "2026-06-07T09:00:00.000Z";

function plan(overrides: Partial<AdaptiveRetrievalApplyPlan> = {}): AdaptiveRetrievalApplyPlan {
  return {
    kind: "adaptive_retrieval_threshold_delta",
    scope_key: "project:memory-xx",
    query_type: "project_context",
    delta: "loosen",
    max_delta: 0.01,
    ...overrides,
  };
}

test("adaptive retrieval apply writes a bounded policy override and governance action", async () => {
  const database = new InMemoryWriteDatabase(() => now);

  const result = await executeAdaptiveRetrievalThresholdPlan(database, {
    plan: plan(),
    actorId: "governance-test",
    runId: "run-1",
    defaultThreshold: 0.2,
    ttlDays: 14,
  });

  const snapshot = await database.snapshot();
  const override = snapshot.governancePolicyOverrides[0];
  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.equal(result.threshold, 0.19);
  assert.equal(override?.policyType, "adaptive_retrieval_confidence_gate");
  assert.equal(override?.selectorHash, stableAdaptiveRetrievalSelectorHash(plan()));
  assert.equal(override?.threshold, 0.19);
  assert.equal(override?.defaultThreshold, 0.2);
  assert.equal(override?.metadata.delta, "loosen");
  assert.equal(override?.expiresAt, "2026-06-21T09:00:00.000Z");
  assert.equal(snapshot.memoryGovernanceActions[0]?.actionType, "adaptive_retrieval_threshold_delta");
  assert.equal(snapshot.memoryGovernanceActions[0]?.status, "applied");
});

test("adaptive retrieval apply refuses explicit memory lookup selectors", async () => {
  const database = new InMemoryWriteDatabase(() => now);

  const result = await executeAdaptiveRetrievalThresholdPlan(database, {
    plan: plan({ scope_key: "memory:exact-id" }),
    actorId: "governance-test",
  });

  const snapshot = await database.snapshot();
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked_reason, "explicit_memory_lookup_not_adaptive");
  assert.equal(snapshot.governancePolicyOverrides.length, 0);
  assert.equal(snapshot.memoryGovernanceActions[0]?.status, "reported");
});
