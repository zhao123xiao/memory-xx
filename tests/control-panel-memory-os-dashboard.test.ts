import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildMemoryOsDashboardModel } from "../scripts/control-panel/memory-os-dashboard";
import { renderControlPanelHtml } from "../scripts/control-panel/renderers";
import { createControlPanelHandler } from "../scripts/control-panel/routes";

test("memory os dashboard model turns evolve summary into operator-focused governance cards", () => {
  const model = buildMemoryOsDashboardModel({
    generated_at: "2026-06-05T14:00:00.000Z",
    mode: "dry_run",
    report_only: true,
    apply_allowed: false,
    summary: {
      pending_total: 124,
      pending_safe_close_candidates: 115,
      pending_safe_close_excluded_for_human_review: 9,
      pending_keep_pending: 3,
      temporal_validity_debt_candidates: 36,
      temporal_transition_candidates: 0,
      graph_orphan_candidates: 230,
      graph_relation_repair_candidates: 200,
      graph_successor_discovery_candidates: 6,
      topic_alias_candidates: 6,
      topic_normalization_candidates: 6,
      topic_normalization_review_queue_candidates: 6,
      memory_os_readiness_candidates: 4,
      memory_os_overall_readiness_percent: 36,
      memory_os_lowest_readiness_domain: "storage",
      memory_os_top_blockers: "storage:236,governance:124,update:36",
      memory_os_storage_top_blockers: "graph_relation_repair.review_successor_before_retarget:200,graph_orphan.non_current_relation_target:185,topic_normalization_review.review_topic_normalization:6",
    },
    sections: {
      memory_os_readiness: {
        summary: {
          domains: [
            {
              domain: "storage",
              action_candidates: 236,
              status: "needs_attention",
              readiness_percent: 20,
              evidence_keys: ["graph_orphan_candidates", "graph_relation_repair_candidates"],
              recommended_next_step: "close graph structuring debt before treating graph recall as a primary context source",
              top_blockers: [
                {
                  source: "graph_relation_repair",
                  reason: "review_successor_before_retarget",
                  action_candidates: 200,
                  recommended_next_step: "review_successor_before_retarget",
                },
              ],
            },
            {
              domain: "maintenance",
              action_candidates: 0,
              status: "clean",
              readiness_percent: 100,
              evidence_keys: ["recall_feedback_candidates"],
              recommended_next_step: "feed recall and extraction quality evidence back into policy loops",
              top_blockers: [],
            },
          ],
        },
      },
    },
  });

  assert.equal(model.ok, true);
  assert.equal(model.report_only, true);
  assert.equal(model.apply_allowed, false);
  assert.equal(model.readiness.percent, 36);
  assert.equal(model.readiness.lowest_domain, "storage");
  assert.deepEqual(model.readiness.top_blockers.map((item) => [item.domain, item.count]), [
    ["storage", 236],
    ["governance", 124],
    ["update", 36],
  ]);
  assert.deepEqual(model.cards.map((card) => [card.id, card.value, card.severity]), [
    ["readiness", 36, "critical"],
    ["pending_review", 124, "warning"],
    ["storage_graph_debt", 236, "critical"],
    ["temporal_update_debt", 36, "warning"],
  ]);
  assert.deepEqual(model.command_center.prioritized_work.map((item) => [
    item.rank,
    item.domain,
    item.label,
    item.count,
    item.severity,
    item.target_queue,
    item.target_anchor,
    item.mode,
  ]), [
    [1, "storage", "Resolve relation repair blockers", 200, "critical", "relation_repair_review", "memory-os-relation-repair-review", "report_only"],
    [2, "storage", "Review graph orphan evidence", 230, "critical", "graph_orphan_review", "memory-os-graph-orphan-review", "report_only"],
    [3, "governance", "Triage pending approval debt", 124, "critical", "pending_review", "memory-os-pending-review", "report_only"],
    [4, "update", "Review temporal validity debt", 36, "warning", "temporal_review", "memory-os-temporal-review", "report_only"],
  ]);
  assert.match(model.command_center.prioritized_work[0]?.why_now ?? "", /Storage is the lowest readiness domain/);
  assert.match(model.command_center.prioritized_work[2]?.recommended_next_step ?? "", /human review/);
  assert.deepEqual(model.debt_burndown.summary, {
    total_action_candidates: 590,
    estimated_batches: 27,
    mode: "report_only",
    apply_allowed: false,
  });
  assert.deepEqual(model.debt_burndown.phases.map((phase) => [
    phase.order,
    phase.domain,
    phase.label,
    phase.queue,
    phase.count,
    phase.batch_size,
    phase.estimated_batches,
    phase.target_anchor,
    phase.mode,
  ]), [
    [1, "storage", "Relation repair successor review", "relation_repair_review", 200, 25, 8, "memory-os-relation-repair-review", "report_only"],
    [2, "storage", "Graph orphan lane review", "graph_orphan_review", 230, 25, 10, "memory-os-graph-orphan-review", "report_only"],
    [3, "governance", "Pending human triage", "pending_review", 124, 20, 7, "memory-os-pending-review", "report_only"],
    [4, "update", "Temporal snapshot isolation review", "temporal_review", 36, 20, 2, "memory-os-temporal-review", "report_only"],
  ]);
  assert.match(model.debt_burndown.phases[0]?.verification_gate ?? "", /successor/);
  assert.match(model.debt_burndown.phases[2]?.exit_condition ?? "", /pending_total/);
  assert.deepEqual(model.readiness_explainer.domains.map((domain) => [
    domain.domain,
    domain.readiness_percent,
    domain.status,
    domain.risk_level,
    domain.primary_blocker,
    domain.target_anchor,
    domain.mode,
  ]), [
    ["storage", 20, "needs_attention", "critical", "graph_relation_repair.review_successor_before_retarget:200", "memory-os-relation-repair-review", "report_only"],
    ["maintenance", 100, "clean", "ok", "none", "memory-os-actions", "report_only"],
  ]);
  assert.deepEqual(model.readiness_explainer.domains[0]?.evidence_keys, ["graph_orphan_candidates", "graph_relation_repair_candidates"]);
  assert.match(model.readiness_explainer.domains[0]?.recovery_gate ?? "", /action_candidates/);
  assert.equal(model.queues.safe_close.count, 115);
  assert.equal(model.queues.human_review.count, 9);
  assert.equal(model.queues.keep_pending.count, 3);
  assert.equal(model.queues.graph_repair.count, 230);
  assert.equal(model.queues.topic_normalization.count, 6);
  assert.equal(model.next_actions[0]?.id, "review_human_pending");
  assert.equal(model.next_actions.every((action) => action.enabled === false), true);
  assert.equal(model.next_actions.every((action) => action.mode === "report_only"), true);
});

test("memory os dashboard model uses production graph debt for storage cards when lane counts exist", () => {
  const model = buildMemoryOsDashboardModel({
    summary: {
      graph_orphan_candidates: 67,
      graph_orphan_production_candidates: 16,
      graph_orphan_test_only_candidates: 51,
      graph_relation_repair_candidates: 19,
      graph_relation_repair_production_candidates: 1,
      graph_relation_repair_test_only_candidates: 18,
      topic_normalization_review_queue_candidates: 3,
      memory_os_lowest_readiness_domain: "governance",
      memory_os_top_blockers: "governance:22,storage:19,retrieval:5",
      memory_os_overall_readiness_percent: 51,
    },
  });

  assert.deepEqual(model.cards.find((card) => card.id === "storage_graph_debt"), {
    id: "storage_graph_debt",
    label: "Storage Graph Debt",
    value: 19,
    unit: "signals",
    severity: "warning",
    detail: "graph_orphans=16 relation_repair=1 topic_normalization=3",
  });
  assert.deepEqual(
    model.command_center.prioritized_work
      .filter((item) => item.domain === "storage")
      .map((item) => [item.label, item.count]),
    [
      ["Resolve relation repair blockers", 1],
      ["Review graph orphan evidence", 16],
    ],
  );
});

test("memory os dashboard model exposes drill-down domains and remediation evidence", () => {
  const model = buildMemoryOsDashboardModel({
    generated_at: "2026-06-05T14:00:00.000Z",
    summary: {
      pending_total: 127,
      pending_safe_close_candidates: 116,
      pending_safe_close_excluded_for_human_review: 11,
      pending_keep_pending: 5,
      temporal_validity_debt_candidates: 36,
      graph_orphan_candidates: 230,
      graph_relation_repair_candidates: 200,
      topic_normalization_review_queue_candidates: 6,
      memory_os_overall_readiness_percent: 36,
      memory_os_lowest_readiness_domain: "storage",
      memory_os_top_blockers: "storage:236,governance:127,update:36",
      memory_os_storage_top_blockers: "graph_relation_repair.review_successor_before_retarget:200,graph_orphan.non_current_relation_target:185",
    },
    sections: {
      pending_approval_evidence: {
        candidates: [
          {
            id: "pending-human-1",
            recommended_lane: "approve_candidate",
            memory_class: "fact",
            cognitive_type: "semantic",
            signals: ["stable_operational_fact", "progress_snapshot"],
            evidence_summary: "stable_operational_fact; progress_snapshot; source policy matched",
            recall_contract: {
              storage_target: "postgres_memory",
              target_recall_policy: "default",
              default_recall_allowed: true,
            },
            governance: {
              apply_allowed: false,
              report_only: true,
              required_before_apply: ["operator_approval", "scope_policy_gate", "temporal_validity_review"],
            },
            privacy: {
              blocked: false,
              reasons: [],
            },
          },
          {
            id: "pending-keep-1",
            recommended_lane: "keep_pending",
            memory_class: "event",
            cognitive_type: "episodic",
            signals: ["low_confidence"],
            evidence_summary: "low_confidence; insufficient source evidence",
            recall_contract: {
              storage_target: "postgres_memory",
              target_recall_policy: "review_only",
              default_recall_allowed: false,
            },
            governance: {
              apply_allowed: false,
              report_only: true,
              required_before_apply: ["human_review", "operator_approval"],
            },
            privacy: {
              blocked: false,
              reasons: [],
            },
          },
        ],
        summary: {
          by_recommended_lane: {
            event_log_only: 108,
            quarantine_or_reject: 8,
            approve_candidate: 4,
            explicit_issue_candidate: 2,
            keep_pending: 5,
          },
          by_signal: {
            topic_drift: 64,
            progress_snapshot: 31,
            external_domain_fact: 8,
            sensitive_or_private: 4,
          },
        },
      },
      pending_safe_close: {
        candidates: [
          {
            id: "pending-event-1",
            operation: "event_log_only",
            autonomous_action: "event_log_only",
            memory_class: "event",
            cognitive_type: "episodic",
            target_recall_policy: "never",
            storage_target: "event_log",
            default_recall_allowed: false,
            reasons: ["assistant_process_noise"],
            signals: ["assistant_process_noise"],
            apply_allowed: false,
            rollback_plan: {
              action: "restore_candidate_state",
              restore_lifecycle_status: "candidate",
              restore_review_state: "pending",
            },
          },
          {
            id: "pending-reject-1",
            operation: "reject_or_quarantine",
            autonomous_action: "reject_test_noise",
            memory_class: "noise",
            cognitive_type: "episodic",
            target_recall_policy: "never",
            storage_target: "quarantine",
            default_recall_allowed: false,
            reasons: ["test_or_canary_noise"],
            signals: ["test_or_canary_noise"],
            apply_allowed: false,
            rollback_plan: {
              action: "restore_candidate_state",
              restore_lifecycle_status: "candidate",
              restore_review_state: "pending",
            },
          },
        ],
        review_queue: {
          excluded_for_human_review: [
            {
              id: "pending-human-1",
              recommended_lane: "approve_candidate",
              reasons: ["stable operational fact"],
              required_before_apply: ["operator_approval", "scope_policy_gate"],
            },
          ],
        },
        summary: {
          by_operation: {
            event_log_only: 108,
            reject_or_quarantine: 8,
          },
          blockers: ["operator_approval_required", "apply_not_implemented"],
        },
      },
      temporal_validity_debt: {
        candidates: [
          {
            memory_id: "ci-progress",
            scope: "project:memory-xx",
            title: "CI progress",
            content_preview: "GitHub CI build-and-test 还在跑，当前进度约 98%。",
            memory_type: "status",
            memory_class: "operational_issue",
            cognitive_type: "episodic",
            recall_policy: "default",
            fact_status: "current",
            reasons: ["progress_snapshot_missing_review_at", "episodic_current_default_recall"],
            suggested_action: "isolate_temporal_snapshot",
            suggested_recall_policy: "explicit_only",
            suggested_fact_status: "historical",
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              valid_at: null,
              invalid_at: null,
              observed_at: "2026-06-05T00:00:00.000Z",
              review_at: null,
              expires_at: null,
              updated_at: "2026-06-05T00:00:00.000Z",
            },
          },
          {
            memory_id: "old-port",
            scope: "project:memory-xx",
            title: "Old port",
            content_preview: "Old API port was 4001 before migration.",
            memory_type: "fact",
            memory_class: "long_term_fact",
            cognitive_type: "semantic",
            recall_policy: "default",
            fact_status: "current",
            reasons: ["invalidated_fact_still_current"],
            suggested_action: "review_temporal_metadata",
            suggested_recall_policy: "default",
            suggested_fact_status: "historical",
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              valid_at: "2026-04-01T00:00:00.000Z",
              invalid_at: "2026-05-20T00:00:00.000Z",
              observed_at: null,
              review_at: null,
              expires_at: null,
              updated_at: "2026-06-05T00:00:00.000Z",
            },
          },
        ],
        summary: {
          by_reason: {
            progress_snapshot_missing_review_at: 1,
            episodic_current_default_recall: 1,
            invalidated_fact_still_current: 1,
          },
          by_suggested_action: {
            isolate_temporal_snapshot: 1,
            review_temporal_metadata: 1,
          },
        },
      },
      adaptive_retrieval: {
        candidates: [
          {
            scope_key: "project:dense-project",
            query_type: "exact_lookup",
            trace_count: 24,
            empty_recall_count: 0,
            empty_recall_rate: 0,
            feedback_count: 6,
            negative_feedback_count: 3,
            false_positive_count: 2,
            negative_feedback_rate: 0.5,
            avg_top1_distance: 0.18,
            avg_top1_top2_gap: 0.01,
            avg_top1_score: 0.86,
            avg_top1_rerank_score: 0.82,
            suggested_action: "tighten_threshold",
            reason: "negative_feedback_pressure",
            threshold_decision: {
              action: "tighten_threshold",
              proposed_threshold_delta: "tighten",
              sample_size_ok: true,
              false_positive_guard_ok: false,
              eligible_for_apply: false,
            },
            apply_allowed: false,
            blockers: ["report_only", "negative_feedback_guard"],
          },
          {
            scope_key: "project:sparse-project",
            query_type: "procedure_query",
            trace_count: 28,
            empty_recall_count: 18,
            empty_recall_rate: 0.6429,
            feedback_count: 1,
            negative_feedback_count: 0,
            false_positive_count: 0,
            negative_feedback_rate: 0,
            avg_top1_distance: null,
            avg_top1_top2_gap: null,
            avg_top1_score: null,
            avg_top1_rerank_score: null,
            suggested_action: "loosen_threshold",
            reason: "empty_recall_pressure",
            threshold_decision: {
              action: "loosen_threshold",
              proposed_threshold_delta: "loosen",
              sample_size_ok: true,
              false_positive_guard_ok: true,
              eligible_for_apply: true,
            },
            apply_allowed: false,
            blockers: ["report_only"],
          },
          {
            scope_key: "project:small-project",
            query_type: "current_state_query",
            trace_count: 3,
            empty_recall_count: 0,
            empty_recall_rate: 0,
            feedback_count: 0,
            negative_feedback_count: 0,
            false_positive_count: 0,
            negative_feedback_rate: 0,
            avg_top1_distance: 0.25,
            avg_top1_top2_gap: 0.08,
            avg_top1_score: 0.77,
            avg_top1_rerank_score: 0.74,
            suggested_action: "collect_more_samples",
            reason: "sample_size_below_minimum",
            threshold_decision: {
              action: "collect_more_samples",
              proposed_threshold_delta: "none",
              sample_size_ok: false,
              false_positive_guard_ok: true,
              eligible_for_apply: false,
            },
            apply_allowed: false,
            blockers: ["report_only", "sample_size_below_minimum"],
          },
        ],
        summary: {
          traces: 55,
          feedback_events: 7,
          suspicious_feedback_events: 0,
          cohorts: 3,
          report_only: true,
        },
      },
      graph_orphans: {
        candidates: [
          {
            candidate_type: "graph_orphan",
            candidate_id: "graph-orphan:missing_relation:memory-no-relation",
            memory_id: "memory-no-relation",
            scope: "project:memory-xx",
            title: "No relation",
            memory_type: "fact",
            reason: "missing_relation",
            suggested_action: "review_graph_enrichment",
            apply_allowed: false,
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              relation_id: null,
              relation_type: null,
              relation_memory_id: null,
              relation_related_memory_id: null,
              related_lifecycle_status: null,
              related_is_current: null,
              updated_at: "2026-06-05T00:00:00.000Z",
              report_only: true,
            },
          },
          {
            candidate_type: "graph_orphan",
            candidate_id: "graph-orphan:non_current_relation_target:memory-stale:rel-stale",
            memory_id: "memory-stale",
            scope: "project:memory-xx",
            title: "Stale relation",
            memory_type: "fact",
            reason: "non_current_relation_target",
            suggested_action: "review_relation_repair_or_archive",
            apply_allowed: false,
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              relation_id: "rel-stale",
              relation_type: "supports",
              relation_memory_id: "memory-source",
              relation_related_memory_id: "memory-old",
              related_lifecycle_status: "approved",
              related_is_current: false,
              updated_at: "2026-06-05T00:00:00.000Z",
              report_only: true,
            },
          },
        ],
        summary: {
          top_reasons: [
            { reason: "non_current_relation_target", count: 185, suggested_action: "review_relation_repair_or_archive" },
            { reason: "missing_entity_link", count: 15, suggested_action: "review_graph_enrichment" },
          ],
        },
      },
      graph_relation_repair: {
        candidates: [
          {
            candidate_type: "graph_relation_repair",
            candidate_id: "graph-relation-repair:review_successor_before_retarget:rel-stale",
            relation_id: "rel-stale",
            relation_type: "supports",
            source_memory_id: "memory-source",
            current_related_memory_id: "memory-old",
            suggested_related_memory_id: null,
            reason: "non_current_relation_target",
            suggested_action: "review_successor_before_retarget",
            review_blocker: "missing_successor",
            apply_allowed: false,
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              source_exists: true,
              source_lifecycle_status: "approved",
              source_is_current: true,
              target_exists: true,
              target_lifecycle_status: "approved",
              target_is_current: false,
              successor_lifecycle_status: null,
              successor_is_current: null,
              successor_count: 0,
              updated_at: "2026-06-05T00:00:00.000Z",
              report_only: true,
            },
          },
          {
            candidate_type: "graph_relation_repair",
            candidate_id: "graph-relation-repair:retarget_relation_to_successor:rel-retarget",
            relation_id: "rel-retarget",
            relation_type: "supersedes",
            source_memory_id: "memory-source",
            current_related_memory_id: "memory-old",
            suggested_related_memory_id: "memory-current",
            reason: "non_current_relation_target",
            suggested_action: "retarget_relation_to_successor",
            review_blocker: "none",
            apply_allowed: false,
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              source_exists: true,
              source_lifecycle_status: "approved",
              source_is_current: true,
              target_exists: true,
              target_lifecycle_status: "approved",
              target_is_current: false,
              successor_lifecycle_status: "approved",
              successor_is_current: true,
              successor_count: 1,
              updated_at: "2026-06-05T00:00:00.000Z",
              report_only: true,
            },
          },
        ],
        summary: {
          top_actions: [{ action: "review_successor_before_retarget", count: 200 }],
          top_review_blockers: [{ blocker: "missing_successor", count: 200 }],
        },
      },
      graph_successor_discovery: {
        candidates: [
          {
            candidate_id: "graph-successor-discovery:rel-api-port:old-api-port:new-api-port",
            relation_id: "rel-api-port",
            relation_type: "supports",
            source_memory_id: "source-api-port",
            old_target_memory_id: "old-api-port",
            candidate_successor_memory_id: "new-api-port",
            suggested_repair_action: "retarget_relation_after_successor_approval",
            match_type: "same_scope_lexical",
            confidence: 0.82,
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              scope: "project:memory-xx",
              topic: "api-port-old-topic",
              shared_terms: ["api", "migration", "runtime"],
            },
          },
          {
            candidate_id: "graph-successor-discovery:rel-exact:old-exact:new-exact",
            relation_id: "rel-exact",
            relation_type: "supersedes",
            source_memory_id: "source-exact",
            old_target_memory_id: "old-exact",
            candidate_successor_memory_id: "new-exact",
            suggested_repair_action: "retarget_relation_after_successor_approval",
            match_type: "exact_topic",
            confidence: 0.91,
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              scope: "project:memory-xx",
              topic: "runtime-port",
              shared_terms: ["runtime", "port", "migration"],
            },
          },
          {
            candidate_id: "graph-successor-discovery:rel-low:old-low:new-low",
            relation_id: "rel-low",
            relation_type: "supports",
            source_memory_id: "source-low",
            old_target_memory_id: "old-low",
            candidate_successor_memory_id: "new-low",
            suggested_repair_action: "retarget_relation_after_successor_approval",
            match_type: "same_scope_lexical",
            confidence: 0.69,
            blockers: ["report_only", "requires_human_review"],
            evidence: {
              scope: "project:memory-xx",
              topic: "api-port-old-topic",
              shared_terms: ["api", "port"],
            },
          },
        ],
        summary: {
          by_match_type: { same_scope_lexical: 6 },
          top_topic_alias_suggestions: [
            { source_topic: "[l18 graph fixture] qdrant 4096 decision", candidate_topic: "v2.1 phase 3 qdrant", count: 1 },
          ],
        },
      },
      topic_normalization: {
        candidates: [
          {
            candidate_id: "topic-normalization:api-port-old-topic-runtime-port",
            source_topic: "api-port-old-topic",
            canonical_topic: "runtime-port",
            affected_memory_ids: ["old-api-port", "new-api-port"],
            evidence: {
              supporting_discoveries: 2,
              avg_confidence: 0.82,
              affected_memory_count: 2,
            },
          },
        ],
        review_queue: {
          items: [
            {
              queue: "topic_normalization_review",
              priority: "normal",
              normalization_candidate_id: "topic-normalization:api-port-old-topic-runtime-port",
              alias_candidate_id: "topic-alias:api-port-old-topic-runtime-port",
              source_topic: "api-port-old-topic",
              canonical_topic: "runtime-port",
              affected_memory_ids: ["old-api-port", "new-api-port"],
              recommended_action: "review_topic_normalization",
              required_before_apply: [
                "human_review",
                "topic_alias_scope_check",
                "affected_memory_sample_review",
              ],
              evidence: {
                supporting_discoveries: 2,
                avg_confidence: 0.82,
                affected_memory_count: 2,
              },
            },
          ],
        },
        summary: {
          total_aliases: 1,
          total_candidates: 1,
          review_queue_items: 1,
        },
      },
      memory_os_readiness: {
        summary: {
          domains: [
            {
              domain: "storage",
              action_candidates: 236,
              status: "needs_attention",
              readiness_percent: 20,
              recommended_next_step: "close graph structuring debt before treating graph recall as a primary context source",
              top_blockers: [
                {
                  source: "graph_relation_repair",
                  reason: "review_successor_before_retarget",
                  action_candidates: 200,
                  recommended_next_step: "review_successor_before_retarget",
                },
              ],
            },
            {
              domain: "maintenance",
              action_candidates: 0,
              status: "clean",
              readiness_percent: 100,
              recommended_next_step: "feed recall and extraction quality evidence back into policy loops",
              top_blockers: [],
            },
          ],
        },
      },
    },
  });

  assert.deepEqual(model.domain_readiness.map((domain) => [domain.domain, domain.readiness_percent, domain.action_candidates, domain.status]), [
    ["storage", 20, 236, "needs_attention"],
    ["maintenance", 100, 0, "clean"],
  ]);
  assert.equal(model.domain_readiness[0]?.top_blockers[0]?.source, "graph_relation_repair");
  assert.deepEqual(model.queues.safe_close.breakdown.map((item) => [item.label, item.count]), [
    ["event_log_only", 108],
    ["reject_or_quarantine", 8],
  ]);
  assert.deepEqual(model.governance_focus.lanes.slice(0, 2).map((item) => [item.label, item.count]), [
    ["event_log_only", 108],
    ["quarantine_or_reject", 8],
  ]);
  assert.deepEqual(model.governance_focus.signals.slice(0, 2).map((item) => [item.label, item.count]), [
    ["topic_drift", 64],
    ["progress_snapshot", 31],
  ]);
  assert.deepEqual(model.governance_focus.safe_close_blockers, ["operator_approval_required", "apply_not_implemented"]);
  assert.deepEqual(model.governance_focus.pending_review_queue.map((item) => [
    item.id,
    item.recommended_lane,
    item.memory_class,
    item.default_recall_allowed,
    item.required_before_apply.join(","),
    item.recommended_decision,
  ]), [
    ["pending-human-1", "approve_candidate", "fact", true, "operator_approval,scope_policy_gate,temporal_validity_review", "review_then_approve_or_reject"],
    ["pending-keep-1", "keep_pending", "event", false, "human_review,operator_approval", "keep_pending_until_more_evidence"],
  ]);
  assert.deepEqual(model.governance_focus.safe_close_queue.map((item) => [
    item.id,
    item.operation,
    item.autonomous_action,
    item.rollback_action,
    item.recommended_decision,
  ]), [
    ["pending-event-1", "event_log_only", "event_log_only", "restore_candidate_state", "close_as_event_log_only_after_batch_review"],
    ["pending-reject-1", "reject_or_quarantine", "reject_test_noise", "restore_candidate_state", "reject_or_quarantine_after_batch_review"],
  ]);
  assert.deepEqual(model.governance_focus.human_review_exclusions.map((item) => [
    item.id,
    item.recommended_lane,
    item.required_before_apply.join(","),
  ]), [
    ["pending-human-1", "approve_candidate", "operator_approval,scope_policy_gate"],
  ]);
  assert.deepEqual(model.update_focus.temporal_reason_counts.map((item) => [item.label, item.count]), [
    ["episodic_current_default_recall", 1],
    ["invalidated_fact_still_current", 1],
    ["progress_snapshot_missing_review_at", 1],
  ]);
  assert.deepEqual(model.update_focus.temporal_action_counts.map((item) => [item.label, item.count]), [
    ["isolate_temporal_snapshot", 1],
    ["review_temporal_metadata", 1],
  ]);
  assert.deepEqual(model.update_focus.temporal_review_queue.map((item) => [
    item.memory_id,
    item.suggested_action,
    item.suggested_recall_policy,
    item.suggested_fact_status,
    item.recommended_decision,
  ]), [
    ["ci-progress", "isolate_temporal_snapshot", "explicit_only", "historical", "isolate_snapshot_from_default_recall"],
    ["old-port", "review_temporal_metadata", "default", "historical", "review_validity_window_and_fact_status"],
  ]);
  assert.deepEqual(model.update_focus.temporal_review_queue[0]?.reasons, [
    "progress_snapshot_missing_review_at",
    "episodic_current_default_recall",
  ]);
  assert.deepEqual(model.retrieval_focus.calibration_action_counts.map((item) => [item.label, item.count]), [
    ["collect_more_samples", 1],
    ["loosen_threshold", 1],
    ["tighten_threshold", 1],
  ]);
  assert.deepEqual(model.retrieval_focus.calibration_review_lanes.map((item) => [item.label, item.count]), [
    ["collect_more_samples", 1],
    ["loosen_threshold_review", 1],
    ["tighten_threshold_review", 1],
  ]);
  assert.deepEqual(model.retrieval_focus.calibration_review_queue.map((item) => [
    item.scope_key,
    item.query_type,
    item.suggested_action,
    item.proposed_threshold_delta,
    item.review_lane,
    item.recommended_decision,
  ]), [
    ["project:dense-project", "exact_lookup", "tighten_threshold", "tighten", "tighten_threshold_review", "review_false_positive_pressure_before_tightening"],
    ["project:sparse-project", "procedure_query", "loosen_threshold", "loosen", "loosen_threshold_review", "review_empty_recall_pressure_before_loosening"],
    ["project:small-project", "current_state_query", "collect_more_samples", "none", "collect_more_samples", "collect_more_traces_before_calibration"],
  ]);
  assert.equal(model.storage_focus.top_orphan_reasons[0]?.reason, "non_current_relation_target");
  assert.equal(model.storage_focus.repair_actions[0]?.action, "review_successor_before_retarget");
  assert.equal(model.storage_focus.repair_blockers[0]?.blocker, "missing_successor");
  assert.deepEqual(model.storage_focus.orphan_review_queue.map((item) => [
    item.candidate_id,
    item.reason,
    item.suggested_action,
    item.review_lane,
    item.recommended_decision,
  ]), [
    ["graph-orphan:missing_relation:memory-no-relation", "missing_relation", "review_graph_enrichment", "graph_enrichment_review", "review_graph_enrichment_evidence"],
    ["graph-orphan:non_current_relation_target:memory-stale:rel-stale", "non_current_relation_target", "review_relation_repair_or_archive", "relation_repair_review", "review_relation_repair_or_archive"],
  ]);
  assert.deepEqual(model.storage_focus.relation_repair_review_queue.map((item) => [
    item.relation_id,
    item.current_related_memory_id,
    item.suggested_related_memory_id,
    item.suggested_action,
    item.review_blocker,
    item.recommended_decision,
  ]), [
    ["rel-retarget", "memory-old", "memory-current", "retarget_relation_to_successor", "none", "retarget_after_human_review"],
    ["rel-stale", "memory-old", "", "review_successor_before_retarget", "missing_successor", "find_successor_before_retarget"],
  ]);
  assert.deepEqual(model.storage_focus.orphan_review_lanes.map((item) => [item.label, item.count]), [
    ["graph_enrichment_review", 1],
    ["relation_repair_review", 1],
  ]);
  assert.deepEqual(model.storage_focus.relation_repair_review_lanes.map((item) => [item.label, item.count]), [
    ["ready_to_retarget", 1],
    ["successor_discovery_required", 1],
  ]);
  assert.deepEqual(model.storage_focus.successor_review_queue.map((item) => [
    item.relation_id,
    item.old_target_memory_id,
    item.candidate_successor_memory_id,
    item.confidence,
    item.shared_terms.join(","),
    item.review_lane,
    item.recommended_decision,
  ]), [
    ["rel-exact", "old-exact", "new-exact", 0.91, "runtime,port,migration", "retarget_review", "accept_successor_after_human_review"],
    ["rel-api-port", "old-api-port", "new-api-port", 0.82, "api,migration,runtime", "topic_normalization_review", "review_topic_alias_before_retarget"],
    ["rel-low", "old-low", "new-low", 0.69, "api,port", "low_confidence_review", "request_more_evidence"],
  ]);
  assert.deepEqual(model.storage_focus.successor_review_queue[0]?.blockers, ["report_only", "requires_human_review"]);
  assert.deepEqual(model.storage_focus.successor_review_lanes.map((item) => [item.label, item.count]), [
    ["low_confidence_review", 1],
    ["retarget_review", 1],
    ["topic_normalization_review", 1],
  ]);
  assert.deepEqual(model.storage_focus.topic_normalization_review_queue.map((item) => [
    item.priority,
    item.source_topic,
    item.canonical_topic,
    item.affected_memory_count,
    item.avg_confidence,
    item.recommended_decision,
  ]), [
    ["normal", "api-port-old-topic", "runtime-port", 2, 0.82, "review_alias_scope_and_affected_samples"],
  ]);
  assert.deepEqual(model.storage_focus.topic_normalization_priority_counts, [{ label: "normal", count: 1 }]);
  assert.equal(model.storage_focus.successor_alias_suggestions[0]?.source_topic, "[l18 graph fixture] qdrant 4096 decision");
  assert.deepEqual(model.storage_focus.successor_match_types, [{ label: "same_scope_lexical", count: 6 }]);
});

async function invokeHandler(input: {
  readonly token?: string;
  readonly path: string;
  readonly buildMemoryOsDashboard: () => Promise<Record<string, unknown>>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new PassThrough();
  Object.assign(req, {
    method: "GET",
    url: input.path,
    headers: input.token ? { "x-panel-token": input.token } : {},
  });
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return res;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) chunks.push(String(chunk));
    },
  } as unknown as ServerResponse;
  const handler = createControlPanelHandler({
    panelToken: "test-token",
    dbSchema: "memory_v2",
    html: () => "<html></html>",
    flowsHtml: () => "<html></html>",
    buildSummary: async () => ({}),
    buildRecentFlows: async () => ({}),
    buildWriteFlow: async () => ({}),
    buildRecallFlow: async () => ({}),
    buildConversationRecent: async () => ({}),
    buildConversationBatch: async () => ({}),
    buildConversationSession: async () => ({}),
    buildGraphSummary: async () => ({}),
    buildGraphNeighborhood: async () => ({}),
    buildGraphMemoryDetails: async () => ({}),
    buildCodeGraphFromUrl: () => ({}),
    readAutoApprovalRuntimeControls: () => ({}),
    buildMemoryOsDashboard: input.buildMemoryOsDashboard,
  });
  await handler(req as unknown as IncomingMessage, res);
  return { status, body: JSON.parse(chunks.join("") || "{}") as Record<string, unknown> };
}

test("control panel exposes memory os dashboard route as authorized read-only JSON", async () => {
  const unauthorized = await invokeHandler({
    path: "/api/memory-os/evolve",
    buildMemoryOsDashboard: async () => ({}),
  });
  assert.equal(unauthorized.status, 403);

  const authorized = await invokeHandler({
    path: "/api/memory-os/evolve",
    token: "test-token",
    buildMemoryOsDashboard: async () => ({
      ok: true,
      report_only: true,
      apply_allowed: false,
      readiness: { percent: 36 },
      cards: [],
    }),
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.ok, true);
  assert.equal(authorized.body.report_only, true);
  assert.equal(authorized.body.apply_allowed, false);
  assert.deepEqual(authorized.body.readiness, { percent: 36 });
});

test("control panel html includes memory os governance debt workspace", () => {
  const html = renderControlPanelHtml({
    panelToken: "test-token",
    defaultGraphScopeType: "workspace",
    defaultGraphScopeId: "current-instance",
    projectRoot: "/workspace/memory-xx",
    refreshIntervalMs: 30_000,
  });

  assert.match(html, /data-section="memory-os"/);
  assert.match(html, /Memory OS 治理债务中心/);
  assert.match(html, /id="memory-os-command-center"/);
  assert.match(html, /id="memory-os-debt-burndown"/);
  assert.match(html, /id="memory-os-readiness-explainer"/);
  assert.match(html, /data-command-target/);
  assert.match(html, /id="memory-os-readiness"/);
  assert.match(html, /id="memory-os-domains"/);
  assert.match(html, /id="memory-os-queues"/);
  assert.match(html, /id="memory-os-storage-focus"/);
  assert.match(html, /id="memory-os-graph-orphan-review"/);
  assert.match(html, /id="memory-os-graph-orphan-lane-filter"/);
  assert.match(html, /id="memory-os-relation-repair-review"/);
  assert.match(html, /id="memory-os-relation-repair-lane-filter"/);
  assert.match(html, /id="memory-os-update-focus"/);
  assert.match(html, /id="memory-os-temporal-review"/);
  assert.match(html, /id="memory-os-temporal-action-filter"/);
  assert.match(html, /id="memory-os-retrieval-focus"/);
  assert.match(html, /id="memory-os-calibration-review"/);
  assert.match(html, /id="memory-os-calibration-lane-filter"/);
  assert.match(html, /id="memory-os-successor-review"/);
  assert.match(html, /id="memory-os-successor-filter"/);
  assert.match(html, /data-successor-lane/);
  assert.match(html, /id="memory-os-topic-normalization-review"/);
  assert.match(html, /id="memory-os-topic-normalization-priority"/);
  assert.match(html, /id="memory-os-governance-focus"/);
  assert.match(html, /id="memory-os-pending-review"/);
  assert.match(html, /id="memory-os-pending-lane-filter"/);
  assert.match(html, /id="memory-os-safe-close-review"/);
  assert.match(html, /id="memory-os-safe-close-operation-filter"/);
  assert.match(html, /id="memory-os-actions"/);
  assert.match(html, /\/api\/memory-os\/evolve/);
});
