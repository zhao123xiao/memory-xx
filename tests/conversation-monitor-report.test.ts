import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationMonitorReport } from "../app/conversation/conversation-monitor-report";

test("conversation monitor report degrades cleanly when heartbeat is missing", () => {
  const report = buildConversationMonitorReport({
    generatedAt: "2026-06-02T00:00:00.000Z",
    heartbeat: null,
    facts: {
      events: [],
      batches: [],
      memoryRecords: [],
      policyDecisions: [],
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
  assert.match(report.warnings.join(","), /conversation_monitor_heartbeat_missing/u);
});

test("conversation monitor report groups source E2E evidence and ignores assistant-only as user E2E", () => {
  const report = buildConversationMonitorReport({
    generatedAt: "2026-06-02T00:05:00.000Z",
    heartbeat: {
      ok: true,
      heartbeat_path: ".runtime/conversation-monitor-heartbeat.json",
      heartbeat_updated_at: "2026-06-02T00:04:00.000Z",
      source_cursor_path: ".runtime/conversation-sources.cursor.json",
      source_file_count: 2,
      source_events_posted: 3,
      source_skipped: 1,
      source_skipped_existing_files: 0,
      adapters: [
        { adapter: "claude_code_session", roots: [], files: 1, events: 2, skipped: 0, last_seen: "2026-06-02T00:04:00.000Z", last_event_at: "2026-06-02T00:03:00.000Z" },
        { adapter: "openclaw_session", roots: [], files: 1, events: 1, skipped: 1, last_seen: "2026-06-02T00:04:00.000Z", last_event_at: "2026-06-02T00:02:00.000Z" },
      ],
    },
    facts: {
      events: [
        {
          id: "ce1",
          source: "claude-code-session-tail",
          role: "user",
          observed_at: "2026-06-02T00:01:00.000Z",
          processed_at: "2026-06-02T00:02:00.000Z",
          batch_id: "cb1",
          metadata: { source_adapter: "claude_code_session" },
        },
        {
          id: "ce2",
          source: "claude-code-session-tail",
          role: "assistant",
          observed_at: "2026-06-02T00:01:10.000Z",
          processed_at: "2026-06-02T00:02:00.000Z",
          batch_id: "cb1",
          metadata: { source_adapter: "claude_code_session" },
        },
        {
          id: "ce3",
          source: "openclaw-session-tail",
          role: "assistant",
          observed_at: "2026-06-02T00:01:20.000Z",
          processed_at: "2026-06-02T00:02:00.000Z",
          batch_id: "cb2",
          metadata: { source_adapter: "openclaw_session" },
        },
      ],
      batches: [
        { id: "cb1", source: "conversation_ingest", status: "completed", candidate_memory_ids: ["mem1"], no_op_reasons: [], metadata: { source_adapter: "claude_code_session" } },
        { id: "cb2", source: "conversation_ingest", status: "skipped", candidate_memory_ids: [], no_op_reasons: ["assistant_only_ignored"], metadata: { source_adapter: "openclaw_session" } },
      ],
      memoryRecords: [
        { id: "mem1", source: "conversation_ingest", lifecycle_status: "approved", review_state: "silent_approved", metadata: { source_adapter: "claude_code_session", policy_action: "create_memory", recall_policy: "default" } },
        { id: "mem2", source: "conversation_ingest", lifecycle_status: "candidate", review_state: "pending", metadata: { source_adapter: "claude_code_session", policy_action: "create_candidate", recall_policy: "default" } },
        { id: "mem3", source: "conversation_ingest", lifecycle_status: "approved", review_state: "silent_approved", metadata: { source_adapter: "claude_code_session", policy_action: "create_memory", recall_policy: "explicit_only" } },
        { id: "mem4", source: "conversation_ingest", lifecycle_status: "rejected", review_state: "rejected", metadata: { source_adapter: "openclaw_session", policy_action: "reject_by_policy", recall_policy: "never" } },
        { id: "mem5", source: "conversation_ingest", lifecycle_status: "candidate", review_state: "pending", metadata: { source_adapter: "openclaw_session", policy_action: "quarantine_candidate", recall_policy: "never" } },
      ],
      policyDecisions: [
        { source_adapter: "claude_code_session", policy_action: "create_memory" },
        { source_adapter: "openclaw_session", policy_action: "reject_by_policy" },
      ],
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.sources.claude_code_session.user_events, 1);
  assert.equal(report.sources.claude_code_session.assistant_events, 1);
  assert.equal(report.sources.claude_code_session.flushed_sessions, 1);
  assert.equal(report.sources.claude_code_session.created_memory_count, 3);
  assert.equal(report.sources.claude_code_session.candidate_count, 1);
  assert.equal(report.sources.claude_code_session.approved_default_count, 1);
  assert.equal(report.sources.claude_code_session.approved_explicit_only_count, 1);
  assert.equal(report.sources.claude_code_session.default_recallable_count, 1);
  assert.equal(report.sources.claude_code_session.policy_actions.create_memory, 1);
  assert.equal(report.sources.claude_code_session.user_turn_e2e, true);
  assert.equal(report.sources.openclaw_session.user_events, 0);
  assert.equal(report.sources.openclaw_session.assistant_only_batches, 1);
  assert.equal(report.sources.openclaw_session.rejected_by_policy_count, 1);
  assert.equal(report.sources.openclaw_session.quarantined_count, 1);
  assert.equal(report.sources.openclaw_session.user_turn_e2e, false);
});
