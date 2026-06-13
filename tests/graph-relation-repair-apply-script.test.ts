import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeGraphRelationRepairApplyCliArgs,
  parseGraphRelationRetargetPlanJson,
} from "../scripts/memory-graph-relation-repair-apply";

const validPlan = {
  kind: "graph_relation_retarget",
  relation_id: "rel-1",
  source_memory_id: "memory-source",
  old_related_memory_id: "memory-old",
  new_related_memory_id: "memory-new",
} as const;

test("graph relation repair apply CLI defaults to dry-run JSON output", () => {
  const args = normalizeGraphRelationRepairApplyCliArgs([
    "node",
    "script",
    "--plan-file=/tmp/plan.json",
  ]);

  assert.equal(args.apply, false);
  assert.equal(args.dryRun, true);
  assert.equal(args.json, true);
  assert.equal(args.planFile, "/tmp/plan.json");
  assert.match(args.runId, /^graph-relation-repair-apply-/u);
});

test("graph relation repair apply CLI requires an explicit plan file", () => {
  assert.throws(
    () => normalizeGraphRelationRepairApplyCliArgs(["node", "script", "--apply"]),
    /--plan-file is required/u,
  );
});

test("graph relation repair apply CLI allows help without a plan file", () => {
  const args = normalizeGraphRelationRepairApplyCliArgs(["node", "script", "--help"]);

  assert.equal(args.help, true);
  assert.equal(args.planFile, "");
  assert.equal(args.apply, false);
  assert.equal(args.dryRun, true);
});

test("graph relation repair apply CLI accepts explicit apply mode", () => {
  const args = normalizeGraphRelationRepairApplyCliArgs([
    "node",
    "script",
    "--plan-file=/tmp/plan.json",
    "--apply",
    "--actor-id=operator",
    "--run-id=run-1",
  ]);

  assert.equal(args.apply, true);
  assert.equal(args.dryRun, false);
  assert.equal(args.actorId, "operator");
  assert.equal(args.runId, "run-1");
});

test("graph relation repair apply CLI validates retarget plan JSON", () => {
  assert.deepEqual(parseGraphRelationRetargetPlanJson(JSON.stringify(validPlan)), validPlan);
  assert.throws(
    () => parseGraphRelationRetargetPlanJson(JSON.stringify({ ...validPlan, kind: "wrong" })),
    /plan.kind must be graph_relation_retarget/u,
  );
  assert.throws(
    () => parseGraphRelationRetargetPlanJson(JSON.stringify({ ...validPlan, new_related_memory_id: "" })),
    /plan.new_related_memory_id must be a non-empty string/u,
  );
});
