import assert from "node:assert/strict";
import test from "node:test";

import { planFastpathScopeBatches } from "../app/server/fastpath-client";
import { ScopeType } from "../app/shared";

test("fastpath scope planner prioritizes high-signal scopes and defers global", () => {
  const batches = planFastpathScopeBatches(
    [
      { type: ScopeType.User, id: "u-1" },
      { type: ScopeType.Project, id: "p-1" },
      { type: ScopeType.Workspace, id: "current-instance" },
      { type: ScopeType.Global, id: "global" }
    ],
    { initial_scope_count: 3, max_scope_count: 5 }
  );

  assert.deepEqual(batches, [
    [
      { type: ScopeType.User, id: "u-1" },
      { type: ScopeType.Project, id: "p-1" },
      { type: ScopeType.Workspace, id: "current-instance" }
    ],
    [{ type: ScopeType.Global, id: "global" }]
  ]);
});

test("fastpath scope planner searches canonical ledger before live workspace", () => {
  const batches = planFastpathScopeBatches(
    [
      { type: ScopeType.Workspace, id: "current-instance" },
      { type: ScopeType.Global, id: "global" },
      { type: ScopeType.Project, id: "p-1" },
      { type: ScopeType.Workspace, id: "memory-ledger" }
    ],
    { initial_scope_count: 3, max_scope_count: 5 }
  );

  assert.deepEqual(batches[0], [
    { type: ScopeType.Project, id: "p-1" },
    { type: ScopeType.Workspace, id: "memory-ledger" },
    { type: ScopeType.Workspace, id: "current-instance" }
  ]);
  assert.deepEqual(batches[1], [{ type: ScopeType.Global, id: "global" }]);
});
