import assert from "node:assert/strict";
import test from "node:test";

import {
  FilterMode,
  ScopeType,
  Visibility,
  resolveAllowedVisibilitiesFromScopeContext,
  resolveAllowedVisibilitiesFromScopeNames,
  resolveMemoryVisibility,
  resolvePersistedVisibility,
  resolveVisibilityFromScopeName,
  STABLE_VISIBILITY_ORDER
} from "../app/shared";

test("memory visibility contract maps long-term scopes into first-cut business visibilities", () => {
  assert.equal(resolveMemoryVisibility({ scopeType: ScopeType.User }).visibility, Visibility.Personal);
  assert.equal(resolveMemoryVisibility({ scopeType: ScopeType.Workspace }).visibility, Visibility.Shared);
  assert.equal(resolveMemoryVisibility({ scopeType: ScopeType.Project }).visibility, Visibility.Research);
  assert.equal(
    resolveMemoryVisibility({
      scopeType: ScopeType.Global,
      filterMode: FilterMode.Governance
    }).visibility,
    Visibility.Governance
  );
});

test("execution visibility stays as derived-only extension semantics and is not promoted into first-batch persisted output", () => {
  const runVisibility = resolveMemoryVisibility({ scopeType: ScopeType.Run });
  const taskVisibility = resolveMemoryVisibility({ scopeType: ScopeType.Task });

  assert.equal(runVisibility.visibility, Visibility.Execution);
  assert.equal(taskVisibility.visibility, Visibility.Execution);
  assert.equal(runVisibility.persistenceMode, "derived_only_until_schema_lands");
  assert.equal(taskVisibility.persistenceMode, "derived_only_until_schema_lands");
  assert.equal(resolvePersistedVisibility({ scopeType: ScopeType.Run }), null);
  assert.equal(resolvePersistedVisibility({ scopeType: ScopeType.Task }), null);
  assert.match(runVisibility.explanation, /not promoted/i);
});

test("global scope only maps to governance when governance semantics are explicitly active", () => {
  assert.equal(resolvePersistedVisibility({ scopeType: ScopeType.Global }), Visibility.Shared);
  assert.equal(
    resolvePersistedVisibility({
      scopeType: ScopeType.Global,
      filterMode: FilterMode.Governance
    }),
    Visibility.Governance
  );
});

test("route/runtime allowance scope names reuse the shared canonical visibility helper", () => {
  assert.deepEqual(STABLE_VISIBILITY_ORDER, [
    Visibility.Shared,
    Visibility.Personal,
    Visibility.Research,
    Visibility.Governance,
    Visibility.Execution
  ]);
  assert.equal(resolveVisibilityFromScopeName("shared"), Visibility.Shared);
  assert.equal(resolveVisibilityFromScopeName("research"), Visibility.Research);
  assert.equal(resolveVisibilityFromScopeName("execution"), Visibility.Execution);
  assert.equal(resolveVisibilityFromScopeName("unknown"), null);
  assert.deepEqual(resolveAllowedVisibilitiesFromScopeNames(["personal", "shared", "shared"]), [
    Visibility.Shared,
    Visibility.Personal,
  ]);
});

test("allowance fallback helper summarizes scope context without implying persisted record visibility", () => {
  assert.deepEqual(
    resolveAllowedVisibilitiesFromScopeContext({
      workspace_id: "workspace-alpha",
      user_id: "user-1",
      runtime: { run_id: "run-1" },
    }),
    [Visibility.Shared, Visibility.Personal, Visibility.Execution],
  );
});
