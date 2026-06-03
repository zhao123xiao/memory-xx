import assert from "node:assert/strict";
import test from "node:test";
import { createPermissionChecker, hashToken, inspectTokenSeparation, loadScopePolicyMode } from "../app/server/permissions";
import { requiredPermissionForPath, routeLabelForPath } from "../app/server/http-server";

test("legacy API token gets read write feedback but not governance or admin", async () => {
  const checker = createPermissionChecker({ MEMORY_V2_API_TOKEN: "legacy" });
  try {
    assert.equal((await checker.authorizeToken("legacy", "memory:read")).allowed, true);
    assert.equal((await checker.authorizeToken("legacy", "memory:write")).allowed, true);
    assert.equal((await checker.authorizeToken("legacy", "memory:feedback")).allowed, true);
    assert.equal((await checker.authorizeToken("legacy", "memory:governance_apply")).allowed, false);
    assert.equal((await checker.authorizeToken("legacy", "memory:admin")).allowed, false);
  } finally {
    await checker.close();
  }
});

test("legacy permissions can be narrowed but not expanded to admin", async () => {
  const checker = createPermissionChecker({
    MEMORY_V2_API_TOKEN: "legacy",
    MEMORY_V2_LEGACY_TOKEN_PERMISSIONS: "memory:read,memory:admin,memory:governance_apply",
  });
  try {
    assert.equal((await checker.authorizeToken("legacy", "memory:read")).allowed, true);
    assert.equal((await checker.authorizeToken("legacy", "memory:write")).allowed, false);
    assert.equal((await checker.authorizeToken("legacy", "memory:admin")).allowed, false);
  } finally {
    await checker.close();
  }
});

test("admin token has every permission", async () => {
  const checker = createPermissionChecker({ MEMORY_V2_API_TOKEN: "legacy", MEMORY_V2_ADMIN_TOKEN: "admin" });
  try {
    assert.equal((await checker.authorizeToken("admin", "memory:governance_apply")).allowed, true);
    assert.equal((await checker.authorizeToken("admin", "memory:admin")).allowed, true);
  } finally {
    await checker.close();
  }
});

test("token separation detects legacy/admin token overlap", () => {
  assert.deepEqual(inspectTokenSeparation({
    MEMORY_V2_API_TOKEN: "same-token",
    MEMORY_V2_ADMIN_TOKEN: "same-token",
  }), {
    ok: false,
    legacy_configured: true,
    admin_configured: true,
    overlap: true,
  });
  assert.equal(inspectTokenSeparation({
    MEMORY_V2_API_TOKEN: "legacy",
    MEMORY_V2_ADMIN_TOKEN: "admin",
  }).ok, true);
});


test("scope policy defaults to strict and allows explicit single_user rollback", () => {
  assert.equal(loadScopePolicyMode({}), "strict");
  assert.equal(loadScopePolicyMode({ MEMORY_V2_SCOPE_POLICY_MODE: "strict" }), "strict");
  assert.equal(loadScopePolicyMode({ MEMORY_V2_SCOPE_POLICY_MODE: "single_user" }), "single_user");
});

test("default strict scope policy denies legacy token scope grants", async () => {
  const checker = createPermissionChecker({
    MEMORY_V2_API_TOKEN: "legacy",
  });
  try {
    const decision = await checker.authorizeScope({
      token: "legacy",
      permission: "memory:write",
      scopeType: "project",
      scopeId: "project-alpha",
    });
    assert.equal(decision.authenticated, true);
    assert.equal(decision.allowed, false);
    assert.equal(decision.scopeAllowed, false);
    assert.equal(decision.reason, "legacy_token_disallowed_in_strict_scope");
  } finally {
    await checker.close();
  }
});

test("single_user rollback lets legacy token pass scoped checks", async () => {
  const checker = createPermissionChecker({
    MEMORY_V2_API_TOKEN: "legacy",
    MEMORY_V2_SCOPE_POLICY_MODE: "single_user",
  });
  try {
    const decision = await checker.authorizeScope({
      token: "legacy",
      permission: "memory:write",
      scopeType: "project",
      scopeId: "project-alpha",
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.scopeAllowed, true);
    assert.equal(decision.scopePolicyMode, "single_user");
  } finally {
    await checker.close();
  }
});

test("strict scope policy lets admin token bypass DB grants", async () => {
  const checker = createPermissionChecker({
    MEMORY_V2_ADMIN_TOKEN: "admin",
    MEMORY_V2_SCOPE_POLICY_MODE: "strict",
  });
  try {
    const decision = await checker.authorizeScope({
      token: "admin",
      permission: "memory:governance_apply",
      scopeType: "workspace",
      scopeId: "current-instance",
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.scopeAllowed, true);
    assert.equal(decision.reason, "admin_bypass");
  } finally {
    await checker.close();
  }
});

test("requiredPermissionForPath maps key HTTP routes", () => {
  assert.equal(requiredPermissionForPath("/api/memory/v2/unified/recall"), "memory:read");
  assert.equal(requiredPermissionForPath("/api/memory/v2/unified/remember"), "memory:write");
  assert.equal(requiredPermissionForPath("/api/memory/v2/unified/feedback"), "memory:feedback");
  assert.equal(requiredPermissionForPath("/api/memory/v2/unified/forget"), "memory:governance_revert");
  assert.equal(requiredPermissionForPath("/api/memory/v2/mcp/approve"), "memory:governance_apply");
  assert.equal(requiredPermissionForPath("/api/memory/v2/conversation/events"), "memory:write");
  assert.equal(requiredPermissionForPath("/api/memory/v2/conversation/ingest"), "memory:write");
  assert.equal(requiredPermissionForPath("/api/memory/v2/conversation/flush"), "memory:write");
  assert.equal(requiredPermissionForPath("/metrics/prometheus"), "memory:read");
});

test("route labels normalize dynamic ids before metrics emission", () => {
  assert.equal(
    routeLabelForPath("/api/memory/v2/review/memories/memory_abcdef1234567890/approve?token=secret"),
    "/api/memory/v2/review/memories/:memory_id/:action"
  );
  assert.equal(
    routeLabelForPath("/api/memory/v2/intelligence/write-tickets/ticket_abcdef1234567890"),
    "/api/memory/v2/intelligence/write-tickets/:ticket_id"
  );
});

test("hashToken is deterministic sha256 hex", () => {
  assert.equal(hashToken("abc").length, 64);
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.notEqual(hashToken("abc"), hashToken("abcd"));
});
