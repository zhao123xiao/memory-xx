import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAdaptiveRetrievalApplyCliArgs,
  parseAdaptiveRetrievalApplyPlanJson,
} from "../scripts/memory-adaptive-retrieval-apply";

const validPlan = {
  kind: "adaptive_retrieval_threshold_delta",
  scope_key: "project:memory-xx",
  query_type: "project_context",
  delta: "loosen",
  max_delta: 0.01,
} as const;

test("adaptive retrieval apply CLI defaults to dry-run JSON output", () => {
  const args = normalizeAdaptiveRetrievalApplyCliArgs([
    "node",
    "script",
    "--plan-file=/tmp/adaptive-plan.json",
  ]);

  assert.equal(args.apply, false);
  assert.equal(args.dryRun, true);
  assert.equal(args.json, true);
  assert.equal(args.planFile, "/tmp/adaptive-plan.json");
  assert.equal(args.defaultThreshold, 0.2);
  assert.equal(args.ttlDays, 14);
  assert.match(args.runId, /^adaptive-retrieval-apply-/u);
});

test("adaptive retrieval apply CLI requires an explicit plan file", () => {
  assert.throws(
    () => normalizeAdaptiveRetrievalApplyCliArgs(["node", "script", "--apply"]),
    /--plan-file is required/u,
  );
});

test("adaptive retrieval apply CLI accepts apply tuning arguments", () => {
  const args = normalizeAdaptiveRetrievalApplyCliArgs([
    "node",
    "script",
    "--plan-file=/tmp/adaptive-plan.json",
    "--apply",
    "--actor-id=operator",
    "--run-id=run-1",
    "--default-threshold=0.25",
    "--ttl-days=7",
  ]);

  assert.equal(args.apply, true);
  assert.equal(args.dryRun, false);
  assert.equal(args.actorId, "operator");
  assert.equal(args.runId, "run-1");
  assert.equal(args.defaultThreshold, 0.25);
  assert.equal(args.ttlDays, 7);
});

test("adaptive retrieval apply CLI validates apply plan JSON", () => {
  assert.deepEqual(parseAdaptiveRetrievalApplyPlanJson(JSON.stringify(validPlan)), validPlan);
  assert.deepEqual(parseAdaptiveRetrievalApplyPlanJson(JSON.stringify({ apply_plan: validPlan })), validPlan);
  assert.throws(
    () => parseAdaptiveRetrievalApplyPlanJson(JSON.stringify({ ...validPlan, kind: "wrong" })),
    /plan.kind must be adaptive_retrieval_threshold_delta/u,
  );
  assert.throws(
    () => parseAdaptiveRetrievalApplyPlanJson(JSON.stringify({ ...validPlan, scope_key: "memory:exact" })),
    /plan.scope_key must not target explicit memory lookup/u,
  );
});
