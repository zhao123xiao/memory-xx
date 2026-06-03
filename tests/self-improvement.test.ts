import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDeterministicEntries,
  extractLastJsonObject,
  mergeExistingEntry,
  syncMarkdownEntries,
  type SelfImprovementEntry,
} from "../scripts/memory-self-improvement";

test("extractLastJsonObject ignores npm lifecycle banners", () => {
  const parsed = extractLastJsonObject(`
> memory-xx@0.1.0 memory:doctor
> tsx scripts/memory-doctor.ts

{"ok":true,"status":"green"}
`);
  assert.deepEqual(parsed, { ok: true, status: "green" });
});

test("deterministic entries classify command JSON failures as errors", () => {
  const entries = buildDeterministicEntries(
    {
      doctor: { ok: false, error: "stdout_json_parse_failed" },
      status: { ok: true },
      quality: { ok: false, error: "Command failed" },
      recent_recall_failures: [],
    },
    {
      diagnosis: "quality command failed",
      recommended_actions: ["inspect raw command output"],
      validation_commands: ["TMPDIR=/tmp npm run memory:quality -- --json"],
      risk: "high",
    },
    { now: "2026-05-27T10:00:00.000Z", recurrenceThreshold: 3 },
  );

  const errors = entries.filter((entry) => entry.type === "error");
  assert.equal(errors.length, 2);
  assert.ok(errors.some((entry) => entry.summary.includes("doctor command")));
  assert.ok(errors.some((entry) => entry.summary.includes("quality command")));
});

test("deterministic entries treat fresh self-improvement pending status as review debt", () => {
  const entries = buildDeterministicEntries(
    {
      doctor: { ok: true, blockers: [], warnings: [] },
      status: {
        ok: false,
        pending: {
          ok: true,
          candidate_current: 3,
          groups: [
            { source: "memory:self-improvement", agent_id: "memory-xx-self-improvement", age_bucket: "lt_1d", cnt: 3 },
          ],
        },
        command_exit_error: "Command failed: npm --silent run memory:status -- --json",
      },
      quality: { ok: true },
      recent_recall_failures: [],
    },
    {
      diagnosis: "pending candidates require review",
      recommended_actions: ["review pending candidates"],
      validation_commands: ["TMPDIR=/tmp npm run memory:status -- --json"],
      risk: "medium",
    },
    { now: "2026-05-27T10:00:00.000Z", recurrenceThreshold: 3 },
  );

  const highStatusErrors = entries.filter((entry) =>
    entry.type === "error" &&
    entry.priority === "high" &&
    entry.summary.includes("status command")
  );
  assert.equal(highStatusErrors.length, 0);
  assert.ok(entries.some((entry) =>
    entry.type === "ops_proposal" &&
    entry.priority === "medium" &&
    entry.summary.includes("pending self-improvement suggestions")
  ));
});

test("deterministic entries treat mixed fresh pending status as approval backlog", () => {
  const entries = buildDeterministicEntries(
    {
      doctor: { ok: true, blockers: [], warnings: [] },
      status: {
        ok: false,
        pending: {
          ok: true,
          candidate_current: 4,
          groups: [
            { source: "conversation_ingest", agent_id: "codex", age_bucket: "lt_1d", cnt: 3 },
            { source: "memory:self-improvement", agent_id: "memory-xx-self-improvement", age_bucket: "lt_1d", cnt: 1 },
          ],
        },
        command_exit_error: "Command failed: npm --silent run memory:status -- --json",
      },
      quality: { ok: true },
      recent_recall_failures: [],
    },
    {
      diagnosis: "pending candidates require review",
      recommended_actions: ["review pending candidates"],
      validation_commands: ["TMPDIR=/tmp npm run memory:status -- --json"],
      risk: "medium",
    },
    { now: "2026-05-27T10:00:00.000Z", recurrenceThreshold: 3 },
  );

  assert.equal(entries.some((entry) =>
    entry.type === "error" &&
    entry.summary.includes("status command")
  ), false);
  assert.ok(entries.some((entry) =>
    entry.type === "ops_proposal" &&
    entry.priority === "medium" &&
    entry.summary.includes("pending memory candidates")
  ));
});

test("mergeExistingEntry increments recurrence and marks promotion candidate", () => {
  const [entry] = buildDeterministicEntries(
    { doctor: { ok: true, warnings: ["single instance"] }, recent_recall_failures: [] },
    { diagnosis: "warning", recommended_actions: [], validation_commands: [], risk: "medium" },
    { now: "2026-05-27T10:00:00.000Z", recurrenceThreshold: 3 },
  );
  assert.ok(entry);

  const merged = mergeExistingEntry(entry, {
    memory_id: "memory_record_existing",
    entry_id: "LRN-20260525-ABC",
    recurrence_count: 2,
    first_seen: "2026-05-25T10:00:00.000Z",
    see_also: ["old-entry"],
  }, 3);

  assert.equal(merged.entry_id, "LRN-20260525-ABC");
  assert.equal(merged.recurrence_count, 3);
  assert.equal(merged.first_seen, "2026-05-25T10:00:00.000Z");
  assert.equal(merged.promotion_candidate, true);
  assert.ok(merged.see_also.includes("memory_record_existing"));
});

test("markdown sync is explicit and does not overwrite or duplicate entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-self-improvement-"));
  try {
    const entry: SelfImprovementEntry = {
      entry_id: "ERR-20260527-ABC",
      type: "error",
      priority: "high",
      status: "pending",
      area: "infra",
      summary: "doctor command failed",
      details: "The doctor command returned non-JSON output.",
      suggested_action: "Use npm --silent and parse JSON.",
      evidence: { error: "Unexpected token" },
      tags: ["doctor"],
      pattern_key: "error.doctor-json",
      see_also: [],
      recurrence_count: 1,
      first_seen: "2026-05-27T10:00:00.000Z",
      last_seen: "2026-05-27T10:00:00.000Z",
      promotion_candidate: false,
    };

    const first = await syncMarkdownEntries([entry], root);
    const second = await syncMarkdownEntries([entry], root);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);

    const errors = await readFile(path.join(root, ".learnings", "ERRORS.md"), "utf8");
    assert.match(errors, /ERR-20260527-ABC/);
    assert.equal((errors.match(/Pattern-Key: error\.doctor-json/g) ?? []).length, 1);

    const learnings = await readFile(path.join(root, ".learnings", "LEARNINGS.md"), "utf8");
    assert.match(learnings, /^# Learnings/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
