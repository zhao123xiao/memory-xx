import test from "node:test";
import assert from "node:assert/strict";

import { buildLocalAgentProfile, validateLocalAgentId } from "../app/local-agent-profile";

test("local agent profile grants regular agents scoped write without global write", () => {
  const profile = buildLocalAgentProfile({ agentId: "codex-main", projectScopeId: "memory-xx" });
  assert.deepEqual(profile.permissions, ["memory:read", "memory:write", "memory:feedback"]);
  assert.deepEqual(profile.defaultRecallOrder, [
    "project:memory-xx",
    "workspace:current-instance",
    "user:current-instance-owner",
    "user:codex-main",
    "global:global",
  ]);
  const globalGrant = profile.grants.find((grant) => grant.scopeType === "global");
  assert.deepEqual(globalGrant?.permissions, ["memory:read"]);
});

test("local agent profile can opt into owner and global writes explicitly", () => {
  const profile = buildLocalAgentProfile({
    agentId: "governance-agent",
    role: "governance",
    allowUserWrite: true,
    allowGlobalWrite: true,
  });
  assert.equal(profile.permissions.includes("memory:governance_apply"), true);
  assert.deepEqual(
    profile.grants.find((grant) => grant.scopeType === "user" && grant.scopeId === "current-instance-owner")?.permissions,
    ["memory:read", "memory:write", "memory:feedback"],
  );
  assert.deepEqual(
    profile.grants.find((grant) => grant.scopeType === "global")?.permissions,
    ["memory:read", "memory:write", "memory:feedback"],
  );
});

test("local agent id validation rejects unsafe identifiers", () => {
  assert.equal(validateLocalAgentId("openclaw-main"), "openclaw-main");
  assert.throws(() => validateLocalAgentId("OpenClaw"), /agent_id/);
  assert.throws(() => validateLocalAgentId("../bad"), /agent_id/);
});
