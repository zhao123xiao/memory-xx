import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildRuntimeModulePlan,
  buildRuntimeModuleSnapshot,
  RUNTIME_MODULES,
  resolveRuntimeModuleStates,
} from "../app/runtime-modules";
import { buildRuntimeProfileStartServices } from "../scripts/memory-mode";

test("runtime module registry describes full-stack pluggable modules", () => {
  const modules = new Map(RUNTIME_MODULES.map((module) => [module.name, module]));

  for (const name of [
    "wrapper",
    "postgres",
    "redis",
    "qdrant",
    "embedding_proxy",
    "qdrant_proxy",
    "projector",
    "fastpath",
    "lexical_sidecar",
    "llm_upstream",
    "reranker_adapter",
    "mem0_extractor",
    "conversation_monitor",
    "control_panel",
  ]) {
    assert.ok(modules.has(name), `missing module ${name}`);
  }

  assert.equal(modules.get("embedding_proxy")?.source_path, "sidecars/embedding-proxy/embedding-proxy.mjs");
  assert.equal(modules.get("qdrant_proxy")?.source_path, "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs");
  assert.equal(modules.get("reranker_adapter")?.source_path, "sidecars/reranker-adapter/reranker-adapter.mjs");
  assert.equal(modules.get("mem0_extractor")?.source_path, "sidecars/mem0-extractor/extractor.py");
  assert.equal(modules.get("fastpath")?.source_path, "sidecars/fastpath/fastpath.mjs");
  assert.equal(modules.get("lexical_sidecar")?.source_path, "sidecars/lexical-sidecar/lexical-sidecar.mjs");
});

test("runtime module dependencies resolve to registry entries", () => {
  const moduleNames = new Set(RUNTIME_MODULES.map((module) => module.name));
  const unresolved: string[] = [];
  for (const module of RUNTIME_MODULES) {
    for (const dependency of module.dependencies ?? []) {
      if (!moduleNames.has(dependency)) unresolved.push(`${module.name}->${dependency}`);
    }
  }

  assert.deepEqual(unresolved, []);
});

test("runtime module plan keeps core minimal and treats enhanced modules as pluggable", () => {
  const core = buildRuntimeModulePlan("core");
  const enhanced = buildRuntimeModulePlan("enhanced");
  const full = buildRuntimeModulePlan("full");

  assert.deepEqual(
    core.required_modules.map((module) => module.name),
    ["wrapper", "postgres", "redis", "qdrant", "embedding_proxy", "projector"]
  );
  assert.equal(core.optional_modules.some((module) => module.name === "fastpath"), true);
  assert.equal(core.optional_modules.some((module) => module.name === "mem0_extractor"), true);

  assert.equal(enhanced.expected_modules.some((module) => module.name === "fastpath"), true);
  assert.equal(enhanced.expected_modules.some((module) => module.name === "lexical_sidecar"), true);
  assert.equal(enhanced.expected_modules.some((module) => module.name === "reranker_adapter"), true);

  assert.equal(full.required_modules.some((module) => module.name === "mem0_extractor"), true);
  assert.equal(full.required_modules.some((module) => module.name === "conversation_monitor"), true);
  assert.equal(full.required_modules.some((module) => module.name === "control_panel"), true);
});

test("memory mode starts expected services for enhanced profiles", () => {
  const coreServices = buildRuntimeProfileStartServices("core");
  const enhancedServices = buildRuntimeProfileStartServices("enhanced");

  assert.deepEqual(coreServices, [
    "memory-xx-wrapper.service",
    "memory-xx-embedding-proxy-next.service",
    "memory-xx-qdrant-projector-worker.service",
  ]);
  assert.ok(enhancedServices.includes("memory-xx-fastpath.service"));
  assert.ok(enhancedServices.includes("memory-xx-lexical-sidecar.service"));
  assert.ok(enhancedServices.includes("memory-xx-reranker-adapter-next.service"));
  assert.ok(enhancedServices.includes("memory-xx-mem0-extractor.service"));
  assert.ok(enhancedServices.includes("memory-xx-conversation-monitor-worker.service"));
  assert.ok(enhancedServices.includes("memory-xx-control-panel.service"));
});

test("disabled enhanced modules do not block core readiness", () => {
  const states = resolveRuntimeModuleStates("core", {
    MEMORY_XX_FASTPATH_ENABLED: "0",
    MEMORY_XX_LEXICAL_SIDECAR_ENABLED: "false",
    MEMORY_XX_RERANKER_ADAPTER_ENABLED: "off",
    MEMORY_XX_MEM0_EXTRACTOR_ENABLED: "disabled",
  });

  const byName = new Map(states.map((state) => [state.module.name, state]));

  assert.equal(byName.get("fastpath")?.state, "disabled");
  assert.equal(byName.get("lexical_sidecar")?.state, "disabled");
  assert.equal(byName.get("reranker_adapter")?.state, "disabled");
  assert.equal(byName.get("mem0_extractor")?.state, "disabled");
  assert.equal(byName.get("fastpath")?.blocks_profile, false);
  assert.equal(byName.get("mem0_extractor")?.blocks_profile, false);
});

test("required full modules become missing_dependency when enabled but source is unavailable", () => {
  const states = resolveRuntimeModuleStates("full", {
    MEMORY_XX_FASTPATH_ENABLED: "1",
    MEMORY_XX_FASTPATH_SOURCE_AVAILABLE: "0",
    MEMORY_XX_LEXICAL_SIDECAR_ENABLED: "1",
    MEMORY_XX_LEXICAL_SIDECAR_SOURCE_AVAILABLE: "0",
  });

  const byName = new Map(states.map((state) => [state.module.name, state]));

  assert.equal(byName.get("fastpath")?.state, "missing_dependency");
  assert.equal(byName.get("fastpath")?.blocks_profile, true);
  assert.equal(byName.get("lexical_sidecar")?.state, "missing_dependency");
  assert.equal(byName.get("lexical_sidecar")?.blocks_profile, true);
});

test("runtime module snapshot exposes compact health payload names and states", () => {
  const snapshot = buildRuntimeModuleSnapshot("enhanced", {
    MEMORY_XX_FASTPATH_ENABLED: "0",
    MEMORY_XX_MEM0_EXTRACTOR_ENABLED: "1",
    MEMORY_XX_MEM0_EXTRACTOR_SOURCE_AVAILABLE: "0",
  });

  assert.deepEqual(snapshot.required_modules, ["wrapper", "postgres", "redis", "qdrant", "embedding_proxy", "projector"]);
  assert.ok(snapshot.expected_modules.includes("fastpath"));
  assert.equal(snapshot.states.fastpath?.state, "disabled");
  assert.equal(snapshot.states.fastpath?.blocks_profile, false);
  assert.equal(snapshot.states.mem0_extractor?.state, "missing_dependency");
  assert.equal(snapshot.states.mem0_extractor?.source_path, "sidecars/mem0-extractor/extractor.py");
});

test("startable runtime modules have matching public systemd units", () => {
  const missing: string[] = [];
  const missingSourceReferences: string[] = [];
  for (const module of RUNTIME_MODULES) {
    if (!module.startable || !module.service) continue;
    const unitPath = path.join("systemd", module.service);
    try {
      statSync(unitPath);
    } catch {
      missing.push(`${module.name}:${module.service}`);
      continue;
    }
    if (module.source_path) {
      const content = readFileSync(unitPath, "utf8");
      if (!content.includes(module.source_path)) {
        missingSourceReferences.push(`${module.name}:${module.source_path}`);
      }
    }
  }

  assert.deepEqual(missing, []);
  assert.deepEqual(missingSourceReferences, []);
});
