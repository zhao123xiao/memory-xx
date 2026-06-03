import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SkillRegistry } from "../app/skills/skill-registry";
import type { SkillDefinition, SkillResult } from "../app/skills/types";
import {
  DEEP_SEARCH_SKILL,
  SMART_WRITE_SKILL,
  HEALTH_CHECK_SKILL,
  MEMORY_CLEANUP_SKILL,
} from "../app/skills/builtins";

describe("SkillRegistry", () => {
  it("registers and lists skills", () => {
    const reg = new SkillRegistry();
    const def: SkillDefinition = {
      id: "test",
      name: "Test",
      description: "A test skill",
      category: "recall",
      parameters: [{ name: "q", type: "string", description: "query", required: true }],
    };
    reg.register(def, async () => ({ success: true, audit: { skill_id: "test", executed_at: "", duration_ms: 0 } }));
    const list = reg.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "test");
  });

  it("lists skills by category", () => {
    const reg = new SkillRegistry();
    reg.register({ id: "a", name: "A", description: "", category: "recall", parameters: [] }, async () => ({ success: true, audit: { skill_id: "a", executed_at: "", duration_ms: 0 } }));
    reg.register({ id: "b", name: "B", description: "", category: "write", parameters: [] }, async () => ({ success: true, audit: { skill_id: "b", executed_at: "", duration_ms: 0 } }));
    reg.register({ id: "c", name: "C", description: "", category: "recall", parameters: [] }, async () => ({ success: true, audit: { skill_id: "c", executed_at: "", duration_ms: 0 } }));

    assert.equal(reg.listByCategory("recall").length, 2);
    assert.equal(reg.listByCategory("write").length, 1);
    assert.equal(reg.listByCategory("maintenance").length, 0);
  });

  it("has returns correct boolean", () => {
    const reg = new SkillRegistry();
    reg.register({ id: "x", name: "X", description: "", category: "recall", parameters: [] }, async () => ({ success: true, audit: { skill_id: "x", executed_at: "", duration_ms: 0 } }));
    assert.equal(reg.has("x"), true);
    assert.equal(reg.has("y"), false);
  });

  it("gets skill definition", () => {
    const reg = new SkillRegistry();
    reg.register({ id: "z", name: "Z", description: "desc", category: "analysis", parameters: [] }, async () => ({ success: true, audit: { skill_id: "z", executed_at: "", duration_ms: 0 } }));
    const def = reg.get("z");
    assert.ok(def);
    assert.equal(def.name, "Z");
    assert.equal(reg.get("missing"), undefined);
  });

  it("executes a skill successfully", async () => {
    const reg = new SkillRegistry();
    reg.register(
      { id: "echo", name: "Echo", description: "", category: "recall", parameters: [{ name: "msg", type: "string", description: "message", required: true }] },
      async (params) => ({ success: true, data: { echoed: params.msg }, audit: { skill_id: "echo", executed_at: new Date().toISOString(), duration_ms: 10 } })
    );
    const result = await reg.execute("echo", { msg: "hello" });
    assert.equal(result.success, true);
    assert.deepEqual((result.data as { echoed: string }).echoed, "hello");
    assert.ok(result.audit.duration_ms >= 0);
  });

  it("returns error for unknown skill", async () => {
    const reg = new SkillRegistry();
    const result = await reg.execute("nonexistent", {});
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("Skill not found"));
  });

  it("returns error for missing required parameter", async () => {
    const reg = new SkillRegistry();
    reg.register(
      { id: "need_param", name: "NeedParam", description: "", category: "write", parameters: [{ name: "data", type: "string", description: "required data", required: true }] },
      async (params) => ({ success: true, data: params, audit: { skill_id: "need_param", executed_at: "", duration_ms: 0 } })
    );
    const result = await reg.execute("need_param", {});
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("Missing required parameter: data"));
  });

  it("applies default values for optional parameters", async () => {
    const reg = new SkillRegistry();
    reg.register(
      { id: "defaults", name: "Defaults", description: "", category: "recall", parameters: [{ name: "limit", type: "number", description: "limit", default: 10 }] },
      async (params) => ({ success: true, data: params, audit: { skill_id: "defaults", executed_at: "", duration_ms: 0 } })
    );
    const result = await reg.execute("defaults", {});
    assert.equal(result.success, true);
    assert.equal((result.data as { limit: number }).limit, 10);
  });

  it("rejects missing skill permissions before execution", async () => {
    const reg = new SkillRegistry();
    let executed = false;
    reg.register(
      {
        id: "restricted",
        name: "Restricted",
        description: "",
        category: "write",
        requiredPermissions: [{ action: "memory:write" }],
        parameters: [],
      },
      async () => {
        executed = true;
        return { success: true };
      }
    );
    const denied = await reg.execute("restricted", {}, [{ action: "memory:read" }]);
    const allowed = await reg.execute("restricted", {}, [{ action: "memory:write" }]);
    assert.equal(denied.success, false);
    assert.ok(denied.error?.includes("Missing required permissions"));
    assert.equal(allowed.success, true);
    assert.equal(executed, true);
  });

  it("rejects invalid parameter types before execution", async () => {
    const reg = new SkillRegistry();
    let executed = false;
    reg.register(
      {
        id: "typed",
        name: "Typed",
        description: "",
        category: "analysis",
        parameters: [{ name: "limit", type: "number", description: "limit", required: true }],
      },
      async () => {
        executed = true;
        return { success: true };
      }
    );
    const result = await reg.execute("typed", { limit: "10" });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("Invalid parameter type"));
    assert.equal(executed, false);
  });

  it("rejects skills whose scope policy is not satisfied", async () => {
    const reg = new SkillRegistry();
    let executed = false;
    reg.register(
      {
        id: "scoped",
        name: "Scoped",
        description: "",
        category: "write",
        scopePolicy: "explicit_scope_required",
        parameters: [],
      },
      async () => {
        executed = true;
        return { success: true };
      }
    );
    const denied = await reg.execute("scoped", {});
    const allowed = await reg.execute("scoped", { scope_type: "project", scope_id: "p1" });
    assert.equal(denied.success, false);
    assert.ok(denied.error?.includes("explicit scope"));
    assert.equal(allowed.success, true);
    assert.equal(executed, true);
  });

  it("rejects global policy when caller only has scoped permission", async () => {
    const reg = new SkillRegistry();
    reg.register(
      {
        id: "global",
        name: "Global",
        description: "",
        category: "analysis",
        scopePolicy: "global_required",
        parameters: [],
      },
      async () => ({ success: true })
    );
    const denied = await reg.execute("global", {}, [{ action: "memory:read", scope: "project:p1" }]);
    const allowed = await reg.execute("global", {}, [{ action: "memory:read", scope: "global" }]);
    assert.equal(denied.success, false);
    assert.equal(allowed.success, true);
  });

  it("handles executor errors", async () => {
    const reg = new SkillRegistry();
    reg.register(
      { id: "fail", name: "Fail", description: "", category: "maintenance", parameters: [] },
      async () => { throw new Error("executor crashed"); }
    );
    const result = await reg.execute("fail", {});
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("executor crashed"));
  });
});

describe("Built-in Skill Definitions", () => {
  it("deep_search has correct structure", () => {
    assert.equal(DEEP_SEARCH_SKILL.id, "deep_search");
    assert.equal(DEEP_SEARCH_SKILL.category, "recall");
    assert.ok(DEEP_SEARCH_SKILL.parameters.some((p) => p.name === "query" && p.required));
    assert.ok(DEEP_SEARCH_SKILL.parameters.some((p) => p.name === "max_items" && p.default === 5));
  });

  it("smart_write has correct structure", () => {
    assert.equal(SMART_WRITE_SKILL.id, "smart_write");
    assert.equal(SMART_WRITE_SKILL.category, "write");
    assert.ok(SMART_WRITE_SKILL.parameters.some((p) => p.name === "content" && p.required));
  });

  it("health_check has correct structure", () => {
    assert.equal(HEALTH_CHECK_SKILL.id, "health_check");
    assert.equal(HEALTH_CHECK_SKILL.category, "analysis");
  });

  it("memory_cleanup has correct structure", () => {
    assert.equal(MEMORY_CLEANUP_SKILL.id, "memory_cleanup");
    assert.equal(MEMORY_CLEANUP_SKILL.category, "maintenance");
    assert.ok(MEMORY_CLEANUP_SKILL.parameters.some((p) => p.name === "apply_repairs"));
  });

  it("all skills have unique ids", () => {
    const ids = [DEEP_SEARCH_SKILL, SMART_WRITE_SKILL, HEALTH_CHECK_SKILL, MEMORY_CLEANUP_SKILL].map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("all skills have non-empty names and descriptions", () => {
    for (const skill of [DEEP_SEARCH_SKILL, SMART_WRITE_SKILL, HEALTH_CHECK_SKILL, MEMORY_CLEANUP_SKILL]) {
      assert.ok(skill.name.length > 0, `${skill.id} has empty name`);
      assert.ok(skill.description.length > 0, `${skill.id} has empty description`);
    }
  });
});
