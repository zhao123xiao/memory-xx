import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryLandingScanReport } from "../app/governance/memory-landing-scan";

function baseInput(overrides: Record<string, unknown> = {}) {
  const input = {
    generatedAt: "2026-06-02T00:00:00.000Z",
    memoryStatus: {
      ok: true,
      runtime_ok: true,
      governance_ok: true,
      systemd_timer_probe_ok: false,
      status_reason: ["timer_probe_unavailable"],
    },
    pending: { ok: true, candidate_current: 0 },
    qdrantReconcile: {
      ok: true,
      diff: {
        staleMemoryIds: [],
        missingMemoryIds: [],
        payloadDriftMemoryIds: [],
        orphanPointIds: [],
      },
    },
    p1Gate: {
      ok: true,
      status: "degraded",
      blockers: [],
      warnings: ["intelligence_compare_observations_sample_size_below_minimum:0/20"],
    },
    policyReport: {
      windows: {
        last_24h: { total: 1 },
      },
      compare_observations: {
        count: 0,
        minimum: 20,
        status: "below_minimum",
      },
    },
    autoApprovalStatus: {
      candidate_only: { enabled: true, reasons: ["false_positive_proxy_high"] },
      real_scope_enablements: { enabled_scopes: ["project:memory-xx", "user:current-user"] },
      readiness: { update_apply_enablement: { enabled: false, real_project_apply: false } },
    },
    productionGuard: {
      ok: false,
      guard: {
        blockers: ["p1_gate_failed"],
        warnings: ["timer_probe_unavailable"],
      },
    },
    conversationSources: {
      source_adapters: [
        { adapter: "codex_session", files: 10, events: 1, skipped: 2, last_event_at: "2026-06-02T00:00:00.000Z" },
        { adapter: "claude_code_session", files: 10, events: 0, skipped: 0, last_event_at: null },
        { adapter: "openclaw_session", files: 10, events: 0, skipped: 0, last_event_at: null },
      ],
    },
  };
  return { ...input, ...overrides };
}

test("landing scan reports usable runtime while blocking production completion on quality evidence", () => {
  const report = buildMemoryLandingScanReport(baseInput());

  assert.equal(report.ok, true);
  assert.equal(report.current_usability, "usable");
  assert.equal(report.production_landing_complete, false);
  assert.match(report.blockers.join(","), /p1_compare_observations_below_minimum/u);
  assert.match(report.blockers.join(","), /production_guard:p1_gate_failed/u);
  assert.match(report.warnings.join(","), /candidate_only_kill_switch_enabled/u);
  assert.match(report.gaps.join("\n"), /质量对照样本不足/u);
  assert.match(report.next_actions.join("\n"), /memory:intelligence-quality/u);
});

test("landing scan marks project complete only when gates, sources, and candidate-only exit are ready", () => {
  const report = buildMemoryLandingScanReport(baseInput({
    memoryStatus: {
      ok: true,
      runtime_ok: true,
      governance_ok: true,
      systemd_timer_probe_ok: true,
      status_reason: [],
    },
    p1Gate: { ok: true, status: "pass", blockers: [], warnings: [] },
    policyReport: {
      windows: { last_24h: { total: 25 } },
      compare_observations: { count: 20, minimum: 20, status: "ok" },
    },
    autoApprovalStatus: {
      candidate_only: { enabled: false, reasons: [] },
      real_scope_enablements: { enabled_scopes: ["project:memory-xx", "user:current-user"] },
      readiness: { update_apply_enablement: { enabled: false, real_project_apply: false } },
    },
    productionGuard: { ok: true, guard: { blockers: [], warnings: [] } },
    conversationSources: {
      source_adapters: [
        { adapter: "codex_session", files: 10, events: 1, skipped: 2, last_event_at: "2026-06-02T00:00:00.000Z" },
        { adapter: "claude_code_session", files: 10, events: 1, skipped: 0, last_event_at: "2026-06-02T00:00:00.000Z" },
        { adapter: "openclaw_session", files: 10, events: 1, skipped: 0, last_event_at: "2026-06-02T00:00:00.000Z" },
      ],
    },
  }));

  assert.equal(report.ok, true);
  assert.equal(report.production_landing_complete, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.capability_status.conversation_sources, "ok");
});
