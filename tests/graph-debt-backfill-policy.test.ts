import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraphDebtBackfillScopePredicate,
  classifyGraphDebtBackfillLane,
} from "../app/governance/graph-debt-backfill-policy";

test("graph debt backfill policy classifies explicit test scopes and titles as test-only", () => {
  assert.equal(classifyGraphDebtBackfillLane({
    scope_type: "user",
    scope_id: "test-user-alpha",
    title: "test-approve",
    relation_id: null,
  }), "test_only");
  assert.equal(classifyGraphDebtBackfillLane({
    scope_type: "project",
    scope_id: "memory-xx-testing",
    title: "Architecture",
    relation_id: null,
  }), "test_only");
  assert.equal(classifyGraphDebtBackfillLane({
    scope_type: "project",
    scope_id: "accuracy-test",
    title: "AI 模型使用",
    relation_id: "relation_debt_episode_123",
  }), "test_only");
});

test("graph debt backfill policy leaves real workspace/user records in production lane", () => {
  assert.equal(classifyGraphDebtBackfillLane({
    scope_type: "workspace",
    scope_id: "current-instance",
    title: "工作区记忆",
    relation_id: null,
  }), "production");
  assert.equal(classifyGraphDebtBackfillLane({
    scope_type: "user",
    scope_id: "current-instance-owner",
    title: "用户记忆",
    relation_id: null,
  }), "production");
});

test("production-only SQL predicate excludes test-like scope, title, and relation debt rows", () => {
  const predicate = buildGraphDebtBackfillScopePredicate("mr", {
    productionOnly: true,
    relationTable: "\"memory_v2\".\"memory_relations\"",
  });

  assert.match(predicate, /NOT \(lower\(COALESCE\(mr\.scope_id, ''\)\) LIKE '%test%'\)/u);
  assert.match(predicate, /NOT \(lower\(COALESCE\(mr\.title, ''\)\) LIKE '%test%'\)/u);
  assert.match(predicate, /mr\.metadata->>'eval_only' = 'true'/u);
  assert.match(predicate, /mr\.metadata->>'policy_training' = 'true'/u);
  assert.match(predicate, /mr\.metadata->>'recall_policy' = 'test_only'/u);
  assert.match(predicate, /NOT EXISTS \(\s*SELECT 1 FROM "memory_v2"\."memory_relations" rel/u);
  assert.match(predicate, /rel\.id LIKE 'relation_debt_%'/u);
});

test("production-only SQL predicate rejects unsafe relation table input", () => {
  assert.throws(
    () => buildGraphDebtBackfillScopePredicate("mr", {
      productionOnly: true,
      relationTable: "memory_relations; DROP TABLE memory_records",
    }),
    /Unsafe SQL table/u,
  );
});

test("production-only SQL predicate can keep relation debt rows for provenance-only scans", () => {
  const predicate = buildGraphDebtBackfillScopePredicate("mr", {
    productionOnly: true,
    relationTable: "\"memory_v2\".\"memory_relations\"",
    excludeRelationDebt: false,
  });

  assert.match(predicate, /mr\.metadata->>'recall_policy' = 'test_only'/u);
  assert.doesNotMatch(predicate, /relation_debt_/u);
});

test("default SQL predicate is neutral for legacy report-only scans", () => {
  assert.equal(buildGraphDebtBackfillScopePredicate("mr", { productionOnly: false }), "TRUE");
});
