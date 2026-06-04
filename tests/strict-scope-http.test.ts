import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";

import { createTestHarness, request } from "./http-test-harness";
import { KnowledgeScopeGrantRepository, withWriteTransaction } from "../app";
import type {
  AuthIdentity,
  MemoryPermission,
  PermissionChecker,
  PermissionDecision,
  ScopeGrantDecision,
} from "../app/server/permissions";

function tokenFrom(req: IncomingMessage): string {
  const bearer = req.headers.authorization;
  if (typeof bearer === "string" && bearer.startsWith("Bearer ")) return bearer.slice(7).trim();
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey.trim() : "";
}

function hasPermission(identity: AuthIdentity | null, required: MemoryPermission): boolean {
  return Boolean(identity && (identity.permissions.includes("memory:admin") || identity.permissions.includes(required)));
}

function fakeStrictPermissions(): PermissionChecker {
  function identityFor(token: string): AuthIdentity | null {
    if (token === "admin") {
      return {
        agentId: "admin",
        source: "admin_env",
        permissions: ["memory:admin"],
      };
    }
    if (token === "legacy") {
      return {
        agentId: "legacy-api-token",
        source: "legacy_env",
        permissions: ["memory:read", "memory:write", "memory:feedback"],
      };
    }
    if (token.startsWith("trusted-")) {
      return {
        agentId: token,
        source: "trusted_agents",
        permissions: [
          "memory:read",
          "memory:write",
          "memory:feedback",
          "memory:governance_read",
          "memory:governance_apply",
          "memory:governance_revert",
        ],
      };
    }
    return null;
  }

  function tokenDecision(token: string, required: MemoryPermission): PermissionDecision {
    const identity = identityFor(token);
    return {
      authenticated: Boolean(identity),
      allowed: hasPermission(identity, required),
      required,
      identity,
    };
  }

  return {
    authorizeToken: async (token, required) => tokenDecision(token, required),
    authorizeRequest: async (req, required) => tokenDecision(tokenFrom(req), required),
    authorizeScope: async ({ token, permission, scopeType, scopeId }): Promise<ScopeGrantDecision> => {
      const base = tokenDecision(token, permission);
      const scope = { scopeType, scopeId };
      if (!base.authenticated || !base.allowed) {
        return {
          ...base,
          scopePolicyMode: "strict",
          scopeAllowed: false,
          scope,
          reason: base.authenticated ? "permission_denied" : "unauthenticated",
        };
      }
      if (base.identity?.source === "admin_env" || base.identity?.permissions.includes("memory:admin")) {
        return { ...base, scopePolicyMode: "strict", scopeAllowed: true, scope, reason: "admin_bypass" };
      }
      if (base.identity?.source === "legacy_env") {
        return {
          ...base,
          allowed: false,
          scopePolicyMode: "strict",
          scopeAllowed: false,
          scope,
          reason: "legacy_token_disallowed_in_strict_scope",
        };
      }
      const allowed =
        (token === "trusted-project" && scopeType === "project" && scopeId === "scope-a") ||
        (token === "trusted-global" && scopeType === "global" && scopeId === "global");
      return {
        ...base,
        allowed: base.allowed && allowed,
        scopePolicyMode: "strict",
        scopeAllowed: allowed,
        scope,
        reason: allowed ? "trusted_agent_scope_grant" : token === "trusted-revoked"
          ? "scope_grant_revoked"
          : token === "trusted-expired"
            ? "scope_grant_expired"
            : "scope_grant_missing",
      };
    },
    close: async () => undefined,
  };
}

function strictHarness() {
  return createTestHarness({
    permissions: fakeStrictPermissions(),
    env: { MEMORY_XX_SCOPE_POLICY_MODE: "strict" } as NodeJS.ProcessEnv,
  });
}

function defaultStrictHarness() {
  return createTestHarness({
    permissions: fakeStrictPermissions(),
    env: {} as NodeJS.ProcessEnv,
  });
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

test("strict scope denies legacy token on scoped write", async () => {
  const harness = await defaultStrictHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("legacy"),
      body: { scopeType: "project", scopeId: "scope-a", content: "strict legacy denied" },
    });
    assert.equal(res.status, 403);
    assert.equal((res.body as Record<string, unknown>).reason, "legacy_token_disallowed_in_strict_scope");
  } finally {
    await harness.close();
  }
});

test("single_user rollback allows legacy scoped write", async () => {
  const harness = await createTestHarness({
    permissions: fakeStrictPermissions(),
    env: { MEMORY_XX_SCOPE_POLICY_MODE: "single_user" } as NodeJS.ProcessEnv,
  });
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("legacy"),
      body: { scopeType: "project", scopeId: "scope-a", content: "single user rollback write" },
    });
    assert.equal(res.status, 201);
  } finally {
    await harness.close();
  }
});

test("strict scope allows trusted grant and denies missing revoked expired grants", async () => {
  const harness = await strictHarness();
  try {
    const allowed = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { scopeType: "project", scopeId: "scope-a", content: "trusted write" },
    });
    assert.equal(allowed.status, 201);

    for (const token of ["trusted-missing", "trusted-revoked", "trusted-expired"]) {
      const denied = await request(harness.baseUrl, "/api/memory/xx/write", {
        method: "POST",
        headers: auth(token),
        body: { scopeType: "project", scopeId: "scope-a", content: `denied ${token}` },
      });
      assert.equal(denied.status, 403);
    }
  } finally {
    await harness.close();
  }
});

test("strict scope lets admin bypass scoped write", async () => {
  const harness = await strictHarness();
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("admin"),
      body: { scopeType: "project", scopeId: "any-scope", content: "admin write" },
    });
    assert.equal(res.status, 201);
  } finally {
    await harness.close();
  }
});

test("strict review and MCP approval use the memory record scope, not request body scope", async () => {
  const harness = await strictHarness();
  try {
    const write = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("admin"),
      body: { scopeType: "project", scopeId: "scope-a", content: "review scoped memory" },
    });
    const memoryId = (write.body as Record<string, string>).memoryId;

    const denied = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/approve`, {
      method: "POST",
      headers: auth("trusted-missing"),
      body: { scopeType: "project", scopeId: "scope-a" },
    });
    assert.equal(denied.status, 403);

    const approved = await request(harness.baseUrl, "/api/memory/xx/mcp/approve", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { memory_id: memoryId, scope_type: "project", scope_id: "other-scope" },
    });
    assert.notEqual(approved.status, 403);
  } finally {
    await harness.close();
  }
});

test("strict forget and feedback are scoped by memory id", async () => {
  const harness = await strictHarness();
  try {
    const write = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("admin"),
      body: { scopeType: "project", scopeId: "scope-a", content: "feedback scoped memory" },
    });
    const memoryId = (write.body as Record<string, string>).memoryId;

    const deniedFeedback = await request(harness.baseUrl, "/api/memory/xx/unified/feedback", {
      method: "POST",
      headers: auth("trusted-missing"),
      body: { memory_id: memoryId, feedback_type: "used", agent_id: "agent-a" },
    });
    assert.equal(deniedFeedback.status, 403);

    const deniedFeedbackAlias = await request(harness.baseUrl, `/api/memory/xx/feedback/memories/${memoryId}/used`, {
      method: "POST",
      headers: auth("trusted-missing"),
      body: { agent_id: "agent-a" },
    });
    assert.equal(deniedFeedbackAlias.status, 403);

    const allowedFeedback = await request(harness.baseUrl, "/api/memory/xx/unified/feedback", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { memory_id: memoryId, feedback_type: "used", agent_id: "agent-a" },
    });
    assert.notEqual(allowedFeedback.status, 403);

    const deniedForget = await request(harness.baseUrl, "/api/memory/xx/orchestrator/forget-memory", {
      method: "POST",
      headers: auth("trusted-missing"),
      body: { memoryId },
    });
    assert.equal(deniedForget.status, 403);
  } finally {
    await harness.close();
  }
});

test("strict candidate update is scoped by existing memory id", async () => {
  const harness = await strictHarness();
  try {
    const write = await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("admin"),
      body: { scopeType: "project", scopeId: "scope-a", content: "candidate update scoped memory" },
    });
    const memoryId = (write.body as Record<string, string>).memoryId;

    const denied = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/update-candidate`, {
      method: "POST",
      headers: auth("trusted-missing"),
      body: { content: "denied candidate update" },
    });
    assert.equal(denied.status, 403);

    const allowed = await request(harness.baseUrl, `/api/memory/xx/review/memories/${memoryId}/update-candidate`, {
      method: "POST",
      headers: auth("trusted-project"),
      body: { content: "allowed candidate update" },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await harness.close();
  }
});

test("strict knowledge routes require global scope grant", async () => {
  const harness = await strictHarness();
  try {
    const denied = await request(harness.baseUrl, "/api/memory/xx/knowledge/search", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { query: "memory-xx" },
    });
    assert.equal(denied.status, 403);

    const allowed = await request(harness.baseUrl, "/api/memory/xx/knowledge/ingest", {
      method: "POST",
      headers: auth("trusted-global"),
      body: {},
    });
    assert.notEqual(allowed.status, 403);
  } finally {
    await harness.close();
  }
});

test("strict knowledge search allows explicit knowledge collection grant", async () => {
  const harness = await strictHarness();
  try {
    await withWriteTransaction(harness.database, (tx) => new KnowledgeScopeGrantRepository().create(tx, {
      agentId: "trusted-project",
      resourceType: "collection",
      resourceId: "docs",
      permissions: ["memory:read"],
      createdBy: "test"
    }));

    const allowed = await request(harness.baseUrl, "/api/memory/xx/knowledge/search", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { query: "memory-xx", knowledge_collections: ["docs"] },
    });
    assert.notEqual(allowed.status, 403);

    const denied = await request(harness.baseUrl, "/api/memory/xx/knowledge/search", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { query: "memory-xx", knowledge_collections: ["private"] },
    });
    assert.equal(denied.status, 403);
  } finally {
    await harness.close();
  }
});

test("strict unified recall include_knowledge requires global scope grant", async () => {
  const harness = await strictHarness();
  try {
    const denied = await request(harness.baseUrl, "/api/memory/xx/unified/recall", {
      method: "POST",
      headers: auth("trusted-project"),
      body: {
        query: "memory-xx",
        scope_type: "project",
        scope_id: "scope-a",
        include_global: false,
        include_knowledge: true
      },
    });
    assert.equal(denied.status, 403);

    const allowedScope = await request(harness.baseUrl, "/api/memory/xx/unified/recall", {
      method: "POST",
      headers: auth("trusted-global"),
      body: {
        query: "memory-xx",
        scope_type: "global",
        scope_id: "global",
        include_knowledge: true
      },
    });
    assert.notEqual(allowedScope.status, 403);
  } finally {
    await harness.close();
  }
});

test("strict memory_counts includeByScope only returns authorized scope", async () => {
  const harness = await strictHarness();
  try {
    await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("admin"),
      body: { scopeType: "project", scopeId: "scope-a", content: "scope a count memory" },
    });
    await request(harness.baseUrl, "/api/memory/xx/write", {
      method: "POST",
      headers: auth("admin"),
      body: { scopeType: "project", scopeId: "scope-b", content: "scope b count memory" },
    });

    const counts = await request(harness.baseUrl, "/api/memory/xx/orchestrator/memory-counts", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { scopeType: "project", scopeId: "scope-a", includeByScope: true },
    });
    assert.equal(counts.status, 200);
    const byScope = (counts.body as { by_scope?: Array<{ scopeId: string }> }).by_scope ?? [];
    assert.deepEqual(byScope.map((row) => row.scopeId), ["scope-a"]);
  } finally {
    await harness.close();
  }
});

test("strict smart-write requires explicit scope before runtime write", async () => {
  const harness = await strictHarness();
  try {
    for (const path of ["/api/memory/xx/intelligence/smart-write", "/api/memory/xx/mcp/smart-write"]) {
      const denied = await request(harness.baseUrl, path, {
        method: "POST",
        headers: auth("legacy"),
        body: { text: "remember this without an explicit scope" },
      });
      assert.equal(denied.status, 400);
      assert.equal((denied.body as Record<string, unknown>).error, "scope_hint_required");
    }
  } finally {
    await harness.close();
  }
});

test("strict intelligence extract requires scope grant even though it is draft-only", async () => {
  const harness = await strictHarness();
  try {
    const missingScope = await request(harness.baseUrl, "/api/memory/xx/intelligence/extract", {
      method: "POST",
      headers: auth("legacy"),
      body: { text: "what is memory-xx?" },
    });
    assert.equal(missingScope.status, 400);
    assert.equal((missingScope.body as Record<string, unknown>).error, "scope_hint_required");

    const missingGrant = await request(harness.baseUrl, "/api/memory/xx/intelligence/extract", {
      method: "POST",
      headers: auth("trusted-missing"),
      body: { text: "what is memory-xx?", scopeType: "project", scopeId: "scope-a" },
    });
    assert.equal(missingGrant.status, 403);

    const admin = await request(harness.baseUrl, "/api/memory/xx/intelligence/extract", {
      method: "POST",
      headers: auth("admin"),
      body: { text: "what is memory-xx?", scopeType: "project", scopeId: "any-scope" },
    });
    assert.equal(admin.status, 200);

    const trusted = await request(harness.baseUrl, "/api/memory/xx/intelligence/extract", {
      method: "POST",
      headers: auth("trusted-project"),
      body: { text: "what is memory-xx?", scopeType: "project", scopeId: "scope-a" },
    });
    assert.equal(trusted.status, 200);
  } finally {
    await harness.close();
  }
});

test("strict smart-write checks scope grants when scope is provided", async () => {
  const harness = await strictHarness();
  try {
    const denied = await request(harness.baseUrl, "/api/memory/xx/intelligence/smart-write", {
      method: "POST",
      headers: auth("trusted-missing"),
      body: { text: "remember scoped text", scopeType: "project", scopeId: "scope-a" },
    });
    assert.equal(denied.status, 403);

    const legacyDenied = await request(harness.baseUrl, "/api/memory/xx/mcp/smart-write", {
      method: "POST",
      headers: auth("legacy"),
      body: { text: "remember scoped text", scope_hint: { scope_type: "project", scope_id: "scope-a" } },
    });
    assert.equal(legacyDenied.status, 403);
    assert.equal((legacyDenied.body as Record<string, unknown>).reason, "legacy_token_disallowed_in_strict_scope");
  } finally {
    await harness.close();
  }
});

test("single_user rollback keeps no-scope smart-write compatibility", async () => {
  const harness = await createTestHarness({
    permissions: fakeStrictPermissions(),
    env: { MEMORY_XX_SCOPE_POLICY_MODE: "single_user" } as NodeJS.ProcessEnv,
  });
  try {
    const res = await request(harness.baseUrl, "/api/memory/xx/intelligence/smart-write", {
      method: "POST",
      headers: auth("legacy"),
      body: { text: "single user smart write without explicit scope" },
    });
    assert.notEqual(res.status, 400);
    assert.notEqual(res.status, 403);
  } finally {
    await harness.close();
  }
});
