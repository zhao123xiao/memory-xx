import assert from "node:assert/strict";
import { statSync } from "node:fs";
import test from "node:test";

import { buildFullStackCapabilitySnapshot, FULL_STACK_CAPABILITIES } from "../app/full-stack-capabilities";

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

test("full-stack capability manifest covers non-service modules declared in public docs", () => {
  const byName = new Map(FULL_STACK_CAPABILITIES.map((capability) => [capability.name, capability]));

  for (const name of [
    "knowledge_ingest",
    "memory_knowledge_graph",
    "code_graph",
    "temporal_decay",
    "temporal_consolidation",
    "memory_dreaming",
    "policy_evaluation",
    "recall_quality",
    "auto_approval_ops",
    "auto_update_ops",
    "embedding_manifest",
    "embedding_calibration",
    "local_embedding_generation",
    "backup_and_restore",
    "platform_doctor",
    "trusted_agent_tools",
    "qdrant_reconciliation",
  ]) {
    assert.ok(byName.has(name), `missing capability ${name}`);
  }

  assert.equal(byName.get("memory_dreaming")?.default_enabled, false);
  assert.equal(byName.get("policy_evaluation")?.maturity, "beta");
  assert.equal(byName.get("recall_quality")?.profile, "full");
});

test("full-stack capability manifest references exported source and CLI paths", () => {
  const missing: string[] = [];
  for (const capability of FULL_STACK_CAPABILITIES) {
    for (const source of capability.source_paths) {
      if (!exists(source)) missing.push(`${capability.name}:${source}`);
    }
    for (const script of capability.script_paths) {
      if (!exists(script)) missing.push(`${capability.name}:${script}`);
    }
  }

  assert.deepEqual(missing, []);
});

test("full-stack capability manifest keeps experimental capabilities disabled by default", () => {
  const experimentalEnabled = FULL_STACK_CAPABILITIES
    .filter((capability) => capability.maturity === "experimental" && capability.default_enabled)
    .map((capability) => capability.name);

  assert.deepEqual(experimentalEnabled, []);
});

test("full-stack capability snapshot exposes pluggable health state", () => {
  const snapshot = buildFullStackCapabilitySnapshot({
    MEMORY_XX_MEMORY_GRAPH_ENABLED: "1",
    MEMORY_XX_DREAMING_ENABLED: "0",
  });

  assert.equal(snapshot.states.memory_knowledge_graph?.state, "enabled");
  assert.equal(snapshot.states.memory_knowledge_graph?.profile, "enhanced");
  assert.equal(snapshot.states.memory_knowledge_graph?.env_enabled, "MEMORY_XX_MEMORY_GRAPH_ENABLED");
  assert.equal(snapshot.states.memory_dreaming?.state, "disabled");
  assert.equal(snapshot.states.memory_dreaming?.maturity, "experimental");
  assert.equal(snapshot.states.memory_dreaming?.degraded_behavior, "Background dreaming/promoted insight generation is disabled; explicit write/recall continues.");
  assert.ok(snapshot.disabled.includes("memory_dreaming"));
  assert.ok(snapshot.enabled.includes("memory_knowledge_graph"));
});
