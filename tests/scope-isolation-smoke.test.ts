/**
 * Scope Isolation Smoke Tests
 *
 * Verifies that scope filtering in the recall pipeline correctly enforces
 * isolation between runtime scopes (Run/Task), personal scopes (User), and
 * shared long-term scopes (Project/Workspace/Global).
 *
 * Run: node --import tsx --test tests/scope-isolation-smoke.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { FilterMode, LifecycleStatus, ReviewState, ScopeType } from "../app/shared";
import {
  RecallOrchestrator,
  StubLexicalRetriever,
  StubVectorRetriever,
  type RecallRecord,
  type RecallScopeRef
} from "../app/recall";

/** Minimal approved record factory */
function makeRecord(overrides: Partial<RecallRecord> = {}): RecallRecord {
  return {
    memory_id: overrides.memory_id ?? "mem-default",
    content: overrides.content ?? "Alpha project notes for the Q2 milestone.",
    title: overrides.title ?? "Alpha Q2 Notes",
    scope_type: overrides.scope_type ?? ScopeType.Project,
    scope_id: overrides.scope_id ?? "p-alpha",
    lifecycleStatus: LifecycleStatus.Approved,
    isCurrent: true,
    reviewState: ReviewState.Approved,
    project_id: "p-alpha",
    lexical_terms: overrides.lexical_terms ?? ["alpha", "project", "q2", "milestone"],
    semantic_terms: overrides.semantic_terms ?? ["project", "alpha", "milestone"],
    tags: [],
    entity_names: []
  };
}

function makeOrchestrator(records: RecallRecord[]) {
  return new RecallOrchestrator({
    lexical_retriever: new StubLexicalRetriever({ records }),
    vector_retriever: new StubVectorRetriever({ records })
  });
}

// ─── Test 1: Execution isolation ────────────────────────────────────────────
/**
 * Memory written with only a RUNTIME scope (Run/Task) must NOT appear when
 * recalled with a shared long-term scope (Project/Workspace) and no runtime adapter.
 *
 * Rationale: runtime-only memories are ephemeral execution context byproducts.
 * They must not bleed into shared project/workspace recall unless the same
 * runtime context is explicitly present in the recall request.
 */
test("EXECUTION ISOLATION: runtime-only memory does not appear in project-scoped recall", async () => {
  const runtimeOnlyRecord = makeRecord({
    memory_id: "mem-runtime-only",
    content: "Run-42 intermediate result: pivot table generated.",
    title: "Run-42 Result",
    scope_type: ScopeType.Run,
    scope_id: "run-42",
    lexical_terms: ["run-42", "pivot", "table", "result"],
    semantic_terms: ["run", "intermediate", "result"]
  });

  // Recall with project scope only — no runtime context, no runtime adapter
  const orchestrator = makeOrchestrator([runtimeOnlyRecord]);
  const response = await orchestrator.execute({
    query: "run-42 pivot table result",
    scope_context: {
      project_ids: ["p-alpha"]
    }
  });

  const found = response.results.find((r) => r.memory_id === "mem-runtime-only");

  assert.equal(
    found,
    undefined,
    "Runtime-only memory (Run:run-42) MUST NOT appear in project-scoped recall"
  );
});

// ─── Test 2: Personal scope ─────────────────────────────────────────────────
/**
 * Memory written with a USER scope must appear when recalled with the same
 * user_id in scope_context.
 *
 * Rationale: personal/user-scoped memories are private long-term memories
 * tied to an individual. They must be retrievable when the user explicitly
 * asks for personal recall.
 */
test("PERSONAL SCOPE: user-scoped memory appears when recalled with matching user_id", async () => {
  const personalRecord = makeRecord({
    memory_id: "mem-personal",
    content: "Alice prefers dark mode in the evening.",
    title: "Alice Dark Mode Preference",
    scope_type: ScopeType.User,
    scope_id: "u-alice",
    lexical_terms: ["alice", "prefers", "dark", "mode", "evening"],
    semantic_terms: ["preference", "dark", "mode", "evening"]
  });

  const orchestrator = makeOrchestrator([personalRecord]);
  const response = await orchestrator.execute({
    query: "alice prefers dark mode",
    scope_context: {
      user_id: "u-alice"
    }
  });

  const found = response.results.find((r) => r.memory_id === "mem-personal");

  assert.ok(
    found !== undefined,
    "User-scoped memory (User:u-alice) SHOULD appear in personal recall with user_id=u-alice"
  );
  assert.equal(found?.scope.type, ScopeType.User);
  assert.equal(found?.scope.id, "u-alice");
});

// ─── Test 3: Shared pollution ───────────────────────────────────────────────
/**
 * Memory written with a USER scope must NOT appear when recalled with only
 * a shared Project scope (no user_id in scope_context).
 *
 * Rationale: personal memories must not pollute shared/project-level recall.
 * Only memories with Project/Workspace/Global scopes should appear in shared
 * recall. User scope is personal and must not leak into project-level queries.
 */
test("SHARED POLLUTION: personal-only memory does not appear in project-scoped recall", async () => {
  const personalRecord = makeRecord({
    memory_id: "mem-private",
    content: "Bob's private note: anniversary dinner at 7pm.",
    title: "Bob Private Note",
    scope_type: ScopeType.User,
    scope_id: "u-bob",
    lexical_terms: ["bob", "private", "anniversary", "dinner", "7pm"],
    semantic_terms: ["anniversary", "dinner", "private", "note"]
  });

  const sharedRecord = makeRecord({
    memory_id: "mem-shared",
    content: "Team lunch every Friday at noon.",
    title: "Team Lunch",
    scope_type: ScopeType.Project,
    scope_id: "p-alpha",
    lexical_terms: ["team", "lunch", "friday", "noon"],
    semantic_terms: ["team", "lunch", "weekly", "schedule"]
  });

  const orchestrator = makeOrchestrator([personalRecord, sharedRecord]);
  const response = await orchestrator.execute({
    query: "bob anniversary dinner",
    scope_context: {
      project_ids: ["p-alpha"]
      // NO user_id — this is shared/project recall
    }
  });

  const foundPersonal = response.results.find((r) => r.memory_id === "mem-private");
  const foundShared = response.results.find((r) => r.memory_id === "mem-shared");

  assert.equal(
    foundPersonal,
    undefined,
    "Personal memory (User:u-bob) MUST NOT appear in project-scoped recall"
  );
  // The shared record won't match because query terms don't overlap
  // (this is fine — we're only checking the personal record is correctly excluded)
});
