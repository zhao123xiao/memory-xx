import assert from "node:assert/strict";
import test from "node:test";

import { buildPolicyFeedbackBackpropReport } from "../app/governance/policy-feedback-backprop";

test("policy feedback backprop turns recall and extraction feedback into governed policy targets", () => {
  const report = buildPolicyFeedbackBackpropReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    recallQuality: {
      summary: {
        traces: 5,
        feedback_events: 5,
        suspicious_feedback_events: 0,
        cohorts: 3,
      },
      cohorts: [
        {
          memory_class: "operational_issue",
          cognitive_type: "episodic",
          query_type: "current_state_query",
          feedback_count: 2,
          positive_count: 0,
          negative_count: 2,
          false_positive_count: 1,
          false_null_count: 0,
          negative_rate: 1,
          suggested_action: "review_temporal_filter",
        },
        {
          memory_class: "no_memory_returned",
          cognitive_type: "none",
          query_type: "procedure_query",
          feedback_count: 2,
          positive_count: 0,
          negative_count: 0,
          false_positive_count: 0,
          false_null_count: 2,
          negative_rate: 0,
          suggested_action: "open_repair_queue",
        },
      ],
    },
    extractionRecallEval: {
      summary: {
        traces: 5,
        feedback_events: 5,
        suspicious_feedback_events: 0,
        cohorts: 1,
        false_null_cohorts: 1,
        mismatch_cohorts: 2,
      },
      cohorts: [
        {
          query_type: "current_state_query",
          memory_class: "operational_issue",
          cognitive_type: "episodic",
          policy_action: "create_memory",
          recall_policy: "default",
          source: "conversation_ingest",
          feedback_count: 2,
          positive_count: 0,
          negative_count: 2,
          false_positive_count: 1,
          negative_rate: 1,
          mismatch_kind: "episodic_default_recall_leakage",
          suggested_action: "tighten_extraction_or_recall_policy",
        },
        {
          query_type: "current_state_query",
          memory_class: "runtime_noise",
          cognitive_type: "audit",
          policy_action: "create_memory",
          recall_policy: "default",
          source: "conversation_ingest",
          feedback_count: 1,
          positive_count: 0,
          negative_count: 1,
          false_positive_count: 1,
          negative_rate: 1,
          mismatch_kind: "audit_default_recall_leakage",
          suggested_action: "tighten_extraction_or_recall_policy",
        },
      ],
      false_null_cohorts: [
        {
          query_type: "procedure_query",
          feedback_count: 2,
          false_null_count: 2,
          mismatch_kind: "false_null_repair_pressure",
          suggested_action: "add_repair_training_sample",
        },
      ],
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_candidates, 3);
  assert.equal(report.summary.by_target.extraction_policy, 1);
  assert.equal(report.summary.by_target.recall_policy, 1);
  assert.equal(report.summary.by_target.repair_retrieval, 1);
  assert.equal(report.summary.by_source.recall_quality, 2);
  assert.equal(report.summary.by_source.extraction_recall_eval, 3);

  const extraction = report.candidates.find((candidate) => candidate.target === "extraction_policy");
  assert.ok(extraction);
  assert.equal(extraction.suggested_action, "tighten_extraction_or_recall_policy");
  assert.equal(extraction.policy_delta?.recall_policy, "never");
  assert.deepEqual(extraction.blockers, ["report_only", "requires_human_review"]);

  const recall = report.candidates.find((candidate) => candidate.target === "recall_policy");
  assert.ok(recall);
  assert.equal(recall.suggested_action, "review_temporal_filter");
  assert.equal(recall.policy_delta?.query_type, "current_state_query");

  const repair = report.candidates.find((candidate) => candidate.target === "repair_retrieval");
  assert.ok(repair);
  assert.equal(repair.suggested_action, "add_repair_training_sample");
  assert.equal(repair.evidence.false_null_count, 2);
});
