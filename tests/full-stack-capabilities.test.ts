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

test("full-stack capability manifest classifies production CLI scripts not modeled as services", () => {
  const covered = new Set(FULL_STACK_CAPABILITIES.flatMap((capability) => capability.script_paths));
  const expected = [
    "scripts/memory-conversation-sources.ts",
    "scripts/memory-conversation-monitor-report.ts",
    "scripts/memory-governance-audit.ts",
    "scripts/memory-governance-cleanup.ts",
    "scripts/memory-governance-freeze.ts",
    "scripts/memory-governance-revert.ts",
    "scripts/memory-policy-backfill.ts",
    "scripts/memory-pending-canary-report.ts",
    "scripts/memory-pending-governance.ts",
    "scripts/runtime-observability-retention.ts",
    "scripts/trace-retention.ts",
    "scripts/sweep-write-ticket-timeouts.ts",
    "scripts/archive-write-tickets.ts",
    "scripts/memory-migration-preflight.ts",
    "scripts/memory-deployment-bundle.ts",
    "scripts/memory-secrets-audit.ts",
  ];

  assert.deepEqual(expected.filter((script) => !covered.has(script)), []);
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
