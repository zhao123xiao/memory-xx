import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryCanary7dReport } from "../app/governance/memory-canary-7d-report";

function landing(day: number, overrides: Record<string, unknown> = {}) {
  const generatedAt = `2026-06-${String(day).padStart(2, "0")}T04:10:00.000Z`;
  return {
    ok: true,
    generated_at: generatedAt,
    current_usability: "usable",
    production_landing_complete: false,
    blockers: [],
    warnings: [],
    current_state: {
      runtime_ok: true,
      governance_ok: true,
      candidate_current: 0,
      qdrant_drift: 0,
      p1_ok_without_compare_warning: true,
      production_guard_ok: true,
      compare_observations: { count: 20, minimum: 20, status: "ok" },
      conversation_sources: {
        adapters: [
          { adapter: "codex_session", events: 1, last_event_at: generatedAt },
          { adapter: "claude_code_session", events: 1, last_event_at: generatedAt },
          { adapter: "openclaw_session", events: 1, last_event_at: generatedAt },
        ],
      },
      candidate_only: { enabled: true },
    },
    snapshots: {
      policy_report: {
        windows: {
          last_24h: { total: 4 },
          last_7d: { total: 28 },
        },
        leakage_eval: {
          default_leakage: 0,
          explicit_only_default_recall_leakage: 0,
          test_noise_default_recall_leakage: 0,
          unknown_sensitive_or_test_noise_auto_approve: 0,
        },
      },
    },
    ...overrides,
  };
}

test("7d canary report is ready only when all seven daily scans are clean", () => {
  const report = buildMemoryCanary7dReport({
    now: "2026-06-08T05:00:00.000Z",
    reports: [2, 3, 4, 5, 6, 7, 8].map((day) => landing(day)),
    minRealFeedbackSamples: 20,
  });

  assert.equal(report.ok, true);
  assert.equal(report.days_observed, 7);
  assert.equal(report.streaks.runtime_ok_days, 7);
  assert.equal(report.streaks.pending_zero_days, 7);
  assert.equal(report.streaks.qdrant_zero_drift_days, 7);
  assert.equal(report.streaks.p1_pass_days, 7);
  assert.equal(report.streaks.production_guard_ok_days, 7);
  assert.equal(report.candidate_only_exit_ready, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.conversation_source_e2e.claude_code_session.ok, true);
  assert.equal(report.conversation_source_e2e.openclaw_session.ok, true);
});

test("7d canary report blocks candidate-only exit on runtime or source gaps", () => {
  const missingSources = (day: number) => landing(day, {
    current_state: {
      runtime_ok: true,
      governance_ok: true,
      candidate_current: 0,
      qdrant_drift: 0,
      p1_ok_without_compare_warning: true,
      production_guard_ok: true,
      compare_observations: { count: 20, minimum: 20, status: "ok" },
      conversation_sources: {
        adapters: [
          { adapter: "codex_session", events: 1, last_event_at: `2026-06-${String(day).padStart(2, "0")}T04:10:00.000Z` },
          { adapter: "claude_code_session", events: 0, last_event_at: null },
          { adapter: "openclaw_session", events: 0, last_event_at: null },
        ],
      },
      candidate_only: { enabled: true },
    },
  });
  const broken = landing(8, {
    current_state: {
      runtime_ok: true,
      governance_ok: false,
      candidate_current: 2,
      qdrant_drift: 1,
      p1_ok_without_compare_warning: false,
      production_guard_ok: false,
      compare_observations: { count: 10, minimum: 20, status: "below_minimum" },
      conversation_sources: {
        adapters: [
          { adapter: "codex_session", events: 1, last_event_at: "2026-06-08T04:10:00.000Z" },
          { adapter: "claude_code_session", events: 0, last_event_at: null },
          { adapter: "openclaw_session", events: 0, last_event_at: null },
        ],
      },
      candidate_only: { enabled: true },
    },
  });
  const report = buildMemoryCanary7dReport({
    now: "2026-06-08T05:00:00.000Z",
    reports: [2, 3, 4, 5, 6, 7].map((day) => missingSources(day)).concat(broken),
    minRealFeedbackSamples: 20,
  });

  assert.equal(report.ok, false);
  assert.equal(report.candidate_only_exit_ready, false);
  assert.match(report.blockers.join(","), /pending_backlog_nonzero:2/u);
  assert.match(report.blockers.join(","), /qdrant_drift_nonzero:1/u);
  assert.match(report.blockers.join(","), /p1_gate_not_stable:6\/7/u);
  assert.match(report.blockers.join(","), /production_guard_not_stable:6\/7/u);
  assert.match(report.blockers.join(","), /conversation_source_e2e_missing:claude_code_session/u);
  assert.match(report.blockers.join(","), /conversation_source_e2e_missing:openclaw_session/u);
});

test("7d canary report accepts conversation monitor E2E evidence when dry-run has no new events", () => {
  const reports = [2, 3, 4, 5, 6, 7, 8].map((day) => landing(day, {
    current_state: {
      runtime_ok: true,
      governance_ok: true,
      candidate_current: 0,
      qdrant_drift: 0,
      p1_ok_without_compare_warning: true,
      production_guard_ok: true,
      compare_observations: { count: 20, minimum: 20, status: "ok" },
      conversation_sources: {
        adapters: [
          { adapter: "codex_session", events: 0, last_event_at: null },
          { adapter: "claude_code_session", events: 0, last_event_at: null },
          { adapter: "openclaw_session", events: 0, last_event_at: null },
        ],
      },
      conversation_monitor_report: {
        sources: {
          codex_session: { user_turn_e2e: true, user_events: 1, assistant_events: 1, last_event_at: `2026-06-${String(day).padStart(2, "0")}T04:10:00.000Z` },
          claude_code_session: { user_turn_e2e: true, user_events: 1, assistant_events: 1, last_event_at: `2026-06-${String(day).padStart(2, "0")}T04:11:00.000Z` },
          openclaw_session: { user_turn_e2e: true, user_events: 1, assistant_events: 1, last_event_at: `2026-06-${String(day).padStart(2, "0")}T04:12:00.000Z` },
        },
      },
      candidate_only: { enabled: true },
    },
  }));
  const report = buildMemoryCanary7dReport({
    now: "2026-06-08T05:00:00.000Z",
    reports,
    minRealFeedbackSamples: 20,
  });

  assert.equal(report.candidate_only_exit_ready, true);
  assert.equal(report.conversation_source_e2e.codex_session.ok, true);
  assert.equal(report.conversation_source_e2e.claude_code_session.ok, true);
  assert.equal(report.conversation_source_e2e.openclaw_session.ok, true);
});
