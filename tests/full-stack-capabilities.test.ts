import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

import { buildFullStackCapabilitySnapshot, FULL_STACK_CAPABILITIES } from "../app/full-stack-capabilities";
import { RUNTIME_MODULES } from "../app/runtime-modules";

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

test("full-stack capability CLI paths have public npm entrypoints", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const commands = Object.values(packageJson.scripts).join("\n");
  const missing = FULL_STACK_CAPABILITIES
    .flatMap((capability) => capability.script_paths.map((script) => `${capability.name}:${script}`))
    .filter((entry) => {
      const script = entry.split(":").slice(1).join(":");
      return !commands.includes(script);
    });

  assert.deepEqual(missing.sort(), []);
});

test("module catalog documents public npm entrypoints for full-stack capabilities", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const catalog = readFileSync("docs/module-catalog.md", "utf8");
  const missing: string[] = [];
  for (const capability of FULL_STACK_CAPABILITIES) {
    const commandNames = capability.script_paths.flatMap((script) =>
      Object.entries(packageJson.scripts)
        .filter(([, command]) => command.includes(script))
        .map(([name]) => name)
    );
    for (const name of commandNames) {
      if (!catalog.includes(`\`${name}\``)) missing.push(`${capability.name}:${name}`);
    }
  }

  assert.deepEqual(missing.sort(), []);
});

test("module catalog documents base operational npm entrypoints", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const catalog = readFileSync("docs/module-catalog.md", "utf8");
  const baseEntrypoints = [
    "migrate",
    "start",
    "start:worker",
    "memory:status",
    "memory:mode",
    "memory:up",
    "memory:down",
    "memory:agent",
    "memory:review",
    "memory:approve",
    "memory:reject",
    "memory:archive",
    "memory:control-panel",
    "memory:dashboard",
    "memory:report",
    "memory:source-mode",
    "run:qdrant-projector-worker",
    "run:cache-invalidation-worker",
    "run:write-ticket-worker",
    "run:conversation-monitor-worker",
    "run:markdown-projection-worker",
    "run:dream-worker",
    "conversation:codex-bridge",
    "import:staging",
  ];
  const missing = baseEntrypoints
    .filter((name) => name in packageJson.scripts)
    .filter((name) => !catalog.includes(`\`${name}\``));

  assert.deepEqual(missing.sort(), []);
});

test("module catalog documents full-stack capability dependencies", () => {
  const catalog = readFileSync("docs/module-catalog.md", "utf8");
  const missing: string[] = [];

  for (const capability of FULL_STACK_CAPABILITIES) {
    for (const dependency of capability.dependencies ?? []) {
      const rowPattern = new RegExp(`\\| \`${capability.name}\` \\|[^\\n]*\`${dependency}\``, "u");
      if (!rowPattern.test(catalog)) missing.push(`${capability.name}->${dependency}`);
    }
  }

  assert.deepEqual(missing.sort(), []);
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

test("memory npm scripts are classified by runtime modules or full-stack capability manifest", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const scriptPathPattern = /scripts\/[\w.-]+\.ts/gu;
  const runtimeCovered = new Set<string>();
  for (const module of RUNTIME_MODULES) {
    if (module.source_path?.startsWith("scripts/")) runtimeCovered.add(module.source_path);
    for (const match of module.command?.matchAll(scriptPathPattern) ?? []) runtimeCovered.add(match[0]);
  }
  const capabilityCovered = new Set(FULL_STACK_CAPABILITIES.flatMap((capability) => capability.script_paths));
  const baseCommands = new Set([
    "scripts/memory-mode.ts",
    "scripts/memory-status.ts",
    "scripts/memory-agent.ts",
    "scripts/memory-review.ts",
    "scripts/memory-dashboard.ts",
    "scripts/generate-report.ts",
    "scripts/source-mode.ts",
  ]);
  const missing: string[] = [];
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!name.startsWith("memory:")) continue;
    for (const match of command.matchAll(scriptPathPattern)) {
      const script = match[0];
      if (runtimeCovered.has(script) || capabilityCovered.has(script) || baseCommands.has(script)) continue;
      missing.push(`${name}:${script}`);
    }
  }

  assert.deepEqual(missing.sort(), []);
});

test("public non-test npm entrypoints are classified by runtime modules or full-stack capabilities", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const scriptPathPattern = /scripts\/[\w.-]+\.ts/gu;
  const runtimeCovered = new Set<string>();
  for (const module of RUNTIME_MODULES) {
    if (module.source_path?.startsWith("scripts/")) runtimeCovered.add(module.source_path);
    for (const match of module.command?.matchAll(scriptPathPattern) ?? []) runtimeCovered.add(match[0]);
  }
  const capabilityCovered = new Set(FULL_STACK_CAPABILITIES.flatMap((capability) => capability.script_paths));
  const baseCommands = new Set([
    "scripts/generate-report.ts",
    "scripts/memory-agent.ts",
    "scripts/memory-control-panel.ts",
    "scripts/memory-dashboard.ts",
    "scripts/memory-mode.ts",
    "scripts/memory-review.ts",
    "scripts/memory-status.ts",
    "scripts/source-mode.ts",
  ]);
  const ignoredPrefixes = /^(build|check|conversation|import|migrate|open-source|start|test|typecheck)(?::|$)/u;
  const missing: string[] = [];

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (ignoredPrefixes.test(name)) continue;
    for (const match of command.matchAll(scriptPathPattern)) {
      const script = match[0];
      if (runtimeCovered.has(script) || capabilityCovered.has(script) || baseCommands.has(script)) continue;
      missing.push(`${name}:${script}`);
    }
  }

  assert.deepEqual(missing.sort(), []);
});

test("full-stack capability env switches are documented in public env examples", () => {
  const envExample = [
    readFileSync(".env.example", "utf8"),
    readFileSync("configs/memory-xx.env.example", "utf8"),
    readFileSync("configs/memory-xx-wrapper.env.example", "utf8"),
  ].join("\n");
  const missing = FULL_STACK_CAPABILITIES
    .map((capability) => capability.env_enabled)
    .filter((name): name is string => Boolean(name))
    .filter((name) => !envExample.includes(name));

  assert.deepEqual(missing.sort(), []);
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

test("enabled full-stack capabilities expose missing dependency state instead of looking healthy", () => {
  const snapshot = buildFullStackCapabilitySnapshot({
    MEMORY_XX_RECALL_QUALITY_ENABLED: "1",
    MEMORY_XX_RUNTIME_PROFILE: "core",
    MEMORY_XX_FASTPATH_ENABLED: "0",
    MEMORY_XX_LEXICAL_SIDECAR_ENABLED: "0",
    MEMORY_XX_RERANKER_ADAPTER_ENABLED: "0",
  });

  assert.equal(snapshot.states.recall_quality?.state, "missing_dependency");
  assert.equal(snapshot.states.recall_quality?.enabled, true);
  assert.equal(snapshot.states.recall_quality?.reason, "dependency_unavailable:fastpath:disabled");
  assert.deepEqual(snapshot.states.recall_quality?.dependencies, ["fastpath", "lexical_sidecar", "reranker_adapter"]);
  assert.ok(snapshot.missing_dependency.includes("recall_quality"));
});

test("environment-bound capabilities declare dependencies and degrade when those dependencies are off", () => {
  const snapshot = buildFullStackCapabilitySnapshot({
    MEMORY_XX_EMBEDDING_CALIBRATION_ENABLED: "1",
    MEMORY_XX_LOCAL_EMBEDDING_GENERATION_ENABLED: "1",
    MEMORY_XX_QDRANT_RECONCILE_ENABLED: "1",
    MEMORY_XX_CONVERSATION_OPS_ENABLED: "1",
    MEMORY_XX_RELEASE_GOVERNANCE_GATES_ENABLED: "1",
    MEMORY_XX_EMBEDDING_PROXY_ENABLED: "0",
    MEMORY_XX_QDRANT_PROXY_ENABLED: "0",
    MEMORY_XX_CONVERSATION_MONITOR_ENABLED: "0",
    MEMORY_XX_LANDING_SCAN_ENABLED: "0",
  });

  assert.equal(snapshot.states.embedding_calibration?.state, "missing_dependency");
  assert.equal(snapshot.states.embedding_calibration?.reason, "dependency_unavailable:embedding_proxy:disabled");
  assert.deepEqual(snapshot.states.embedding_calibration?.dependencies, ["embedding_proxy"]);

  assert.equal(snapshot.states.local_embedding_generation?.state, "missing_dependency");
  assert.equal(snapshot.states.local_embedding_generation?.reason, "dependency_unavailable:embedding_proxy:disabled");
  assert.deepEqual(snapshot.states.local_embedding_generation?.dependencies, ["embedding_proxy", "qdrant"]);

  assert.equal(snapshot.states.qdrant_reconciliation?.state, "missing_dependency");
  assert.equal(snapshot.states.qdrant_reconciliation?.reason, "dependency_unavailable:qdrant_proxy:disabled");
  assert.deepEqual(snapshot.states.qdrant_reconciliation?.dependencies, ["qdrant", "projector", "qdrant_proxy"]);

  assert.equal(snapshot.states.conversation_ops?.state, "missing_dependency");
  assert.equal(snapshot.states.conversation_ops?.reason, "dependency_unavailable:conversation_monitor:disabled");
  assert.deepEqual(snapshot.states.conversation_ops?.dependencies, ["conversation_monitor"]);

  assert.equal(snapshot.states.release_governance_gates?.state, "missing_dependency");
  assert.equal(snapshot.states.release_governance_gates?.reason, "dependency_unavailable:landing_scan:disabled");
  assert.deepEqual(snapshot.states.release_governance_gates?.dependencies, ["landing_scan", "canary_7d_report", "recall_quality"]);
});

test("full-stack capability dependencies resolve against runtime modules and capabilities", () => {
  const runtimeModuleNames = new Set(RUNTIME_MODULES.map((module) => module.name));
  const capabilityNames = new Set(FULL_STACK_CAPABILITIES.map((capability) => capability.name));
  const unresolved = FULL_STACK_CAPABILITIES.flatMap((capability) =>
    (capability.dependencies ?? [])
      .filter((dependency) => !runtimeModuleNames.has(dependency) && !capabilityNames.has(dependency))
      .map((dependency) => `${capability.name}->${dependency}`)
  );

  assert.deepEqual(unresolved, []);
});

test("capability guard blocks enabled capabilities with missing dependencies", () => {
  const result = spawnSync("node", ["--import", "tsx", "scripts/capability-enabled.ts", "recall_quality"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_XX_RECALL_QUALITY_ENABLED: "1",
      MEMORY_XX_RUNTIME_PROFILE: "core",
      MEMORY_XX_FASTPATH_ENABLED: "0",
      MEMORY_XX_LEXICAL_SIDECAR_ENABLED: "0",
      MEMORY_XX_RERANKER_ADAPTER_ENABLED: "0",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /recall_quality unavailable: missing_dependency/u);
  assert.match(result.stderr, /dependency_unavailable:fastpath:disabled/u);
});
