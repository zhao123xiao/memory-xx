import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildHumanReviewActionPlan,
  isHumanReviewActionAlreadyApplied,
  isExecutableHumanReviewAction,
  parseHumanReviewMarkdown,
} from "../app/governance/human-review-apply";

const reviewMarkdown = `
# memory-xx 人工审核队列（Governance / Retrieval / Temporal）

## 1. Governance / 治理人工审核队列

### G-01 评估 memory-xx 改进方向需对照当前状态并参考主流记忆系统

- id：\`memory_record_approve\`
- scope：\`project:memory-xx\`
- 人工审核结论：\`[审核通过]\`

### G-03 债务处理顺序决策

- id：\`memory_record_reject\`
- scope：\`project:memory-xx\`
- 人工审核结论：\`[这是具体的处理顺序，我觉得并不需要写进记忆里面]\`

### G-04 memory-xx 代码审计与问题分析任务

- id：\`memory_record_doc\`
- scope：\`project:memory-xx\`
- 人工审核结论：\`[类似于这种记忆生成.md的文件我的想法是把这份.md保存到记忆里面，或者放进知识库里面然后建立向量索引]\`

### G-13 Output must be in Chinese

- id：\`memory_record_global\`
- scope：\`project:memory-xx\`
- 人工审核结论：\`[最终的返回结果使用中文推荐写入全局记忆]\`

## 2. Retrieval / 召回校准生产审核队列

### R-01 project:memory-xx / exploratory_semantic

- lane：\`production\`
- 人工审核结论：\`[收集更多的样本]\`

## 3. Update / Temporal 语义债务生产审核队列

### T-01 memory-xx MCP stdio 传输已知问题

- memory_id：\`memory_record_temporal\`
- scope：\`project:memory-xx\`
- suggested_action：\`isolate_temporal_snapshot\`
- 人工审核结论：\`[isolate_temporal_snapshot]\`
`;

test("human review parser extracts governance, retrieval, and temporal decisions", () => {
  const parsed = parseHumanReviewMarkdown(reviewMarkdown);

  assert.equal(parsed.items.length, 6);
  assert.equal(parsed.items[0]?.section, "governance");
  assert.equal(parsed.items[0]?.label, "G-01");
  assert.equal(parsed.items[0]?.memoryId, "memory_record_approve");
  assert.equal(parsed.items[0]?.reviewDecision, "审核通过");
  assert.equal(parsed.items[4]?.section, "retrieval");
  assert.equal(parsed.items[5]?.section, "temporal");
  assert.equal(parsed.items[5]?.memoryId, "memory_record_temporal");
});

test("human review action plan maps approved review decisions into executable action types", () => {
  const plan = buildHumanReviewActionPlan(parseHumanReviewMarkdown(reviewMarkdown), {
    reviewFile: "/tmp/review.md",
    generatedAt: "2026-06-06T00:00:00.000Z",
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.summary.total_items, 6);
  assert.equal(plan.summary.approve_project_memory, 1);
  assert.equal(plan.summary.event_log_only, 1);
  assert.equal(plan.summary.knowledge_index, 1);
  assert.equal(plan.summary.global_constraint, 1);
  assert.equal(plan.summary.collect_more_samples, 1);
  assert.equal(plan.summary.temporal_isolate, 1);

  assert.deepEqual(plan.actions.map((action) => action.action), [
    "approve_project_memory",
    "event_log_only",
    "knowledge_index",
    "global_constraint",
    "collect_more_samples",
    "temporal_isolate",
  ]);
  assert.equal(plan.actions.find((action) => action.action === "global_constraint")?.target_scope, "global:global");
  assert.equal(plan.actions.find((action) => action.action === "temporal_isolate")?.target_recall_policy, "explicit_only");
  assert.equal(plan.actions.find((action) => action.action === "temporal_isolate")?.target_fact_status, "historical");
  assert.equal(plan.actions.find((action) => action.action === "temporal_isolate")?.target_review_required, false);
});

test("human review action plan keeps unknown decisions non-mutating", () => {
  const parsed = parseHumanReviewMarkdown(`
### G-99 Unclear
- id：\`memory_record_unknown\`
- scope：\`project:memory-xx\`
- 人工审核结论：\`[待后续讨论]\`
`);

  const plan = buildHumanReviewActionPlan(parsed, {
    reviewFile: "/tmp/review.md",
    generatedAt: "2026-06-06T00:00:00.000Z",
  });

  assert.equal(plan.summary.keep_pending, 1);
  assert.equal(plan.actions[0]?.action, "keep_pending");
  assert.match(plan.actions[0]?.reason ?? "", /unclassified_human_review_decision/u);
});

test("keep pending human review actions are never executable mutations", () => {
  const plan = buildHumanReviewActionPlan(parseHumanReviewMarkdown(`
### G-99 Unclear but with id
- id：\`memory_record_unknown\`
- scope：\`project:memory-xx\`
- 人工审核结论：\`[待后续讨论]\`
`), {
    reviewFile: "/tmp/review.md",
    generatedAt: "2026-06-06T00:00:00.000Z",
  });

  assert.equal(plan.actions[0]?.action, "keep_pending");
  assert.equal(isExecutableHumanReviewAction(plan.actions[0]!), false);
});

test("human review action detects already applied metadata for idempotent reruns", () => {
  const plan = buildHumanReviewActionPlan(parseHumanReviewMarkdown(`
### T-01 temporal
- memory_id：\`memory_record_temporal\`
- scope：\`project:memory-xx\`
- 人工审核结论：\`[isolate_temporal_snapshot]\`
`), {
    reviewFile: "/tmp/review.md",
    generatedAt: "2026-06-06T00:00:00.000Z",
  });
  const action = plan.actions[0]!;

  assert.equal(isHumanReviewActionAlreadyApplied(action, {
    human_review_apply: {
      label: "T-01",
      action: "temporal_isolate",
      review_decision: "isolate_temporal_snapshot",
    },
  }), true);
  assert.equal(isHumanReviewActionAlreadyApplied(action, {
    human_review_apply: {
      label: "T-01",
      action: "temporal_isolate",
      review_decision: "different",
    },
  }), false);
});

test("human review action plan marks mutating decisions without memory ids as keep pending", () => {
  const parsed = parseHumanReviewMarkdown(`
### G-01 Missing id
- scope：\`project:memory-xx\`
- 人工审核结论：\`[审核通过]\`
`);

  const plan = buildHumanReviewActionPlan(parsed, {
    reviewFile: "/tmp/review.md",
    generatedAt: "2026-06-06T00:00:00.000Z",
  });

  assert.equal(plan.summary.keep_pending, 1);
  assert.equal(plan.actions[0]?.action, "keep_pending");
  assert.match(plan.actions[0]?.reason ?? "", /missing_memory_id/u);
});

test("human review CLI dry-run reads a review file without applying changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-xx-human-review-"));
  const reviewFile = join(dir, "review.md");
  try {
    writeFileSync(reviewFile, reviewMarkdown, "utf8");
    const stdout = execFileSync("node", [
      "--import",
      "tsx",
      "scripts/memory-human-review-apply.ts",
      "--review-file",
      reviewFile,
      "--dry-run",
      "--json",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: "/tmp" },
      encoding: "utf8",
    });
    const result = JSON.parse(stdout) as {
      readonly mode: string;
      readonly plan: {
        readonly summary: Record<string, number>;
        readonly actions: Array<{ readonly action: string }>;
      };
    };

    assert.equal(result.mode, "dry_run");
    assert.equal(result.plan.summary.total_items, 6);
    assert.equal(result.plan.summary.approve_project_memory, 1);
    assert.equal(result.plan.summary.event_log_only, 1);
    assert.equal(result.plan.summary.knowledge_index, 1);
    assert.equal(result.plan.summary.global_constraint, 1);
    assert.equal(result.plan.summary.collect_more_samples, 1);
    assert.equal(result.plan.summary.temporal_isolate, 1);
    assert.equal(result.plan.actions.some((action) => action.action === "global_constraint"), true);
    assert.equal(result.plan.actions.some((action) => action.action === "knowledge_index"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
