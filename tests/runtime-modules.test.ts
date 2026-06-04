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
import {
  buildMemoryModeStatusPayload,
  buildRuntimeProfileStartServices,
  buildRuntimeProfileStopServices,
} from "../scripts/memory-mode";
import { classifyDoctorComponentProfileState } from "../scripts/memory-doctor";

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
    "memory_dreaming",
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

test("runtime module env switches are documented in public env examples", () => {
  const envExample = [
    readFileSync(".env.example", "utf8"),
    readFileSync("configs/memory-xx.env.example", "utf8"),
    readFileSync("configs/memory-xx-wrapper.env.example", "utf8"),
  ].join("\n");
  const missing = RUNTIME_MODULES
    .map((module) => module.env_enabled)
    .filter((name): name is string => Boolean(name))
    .filter((name) => !envExample.includes(name));

  assert.deepEqual(missing.sort(), []);
});

test("runtime registry covers public worker entrypoints and control panel service references", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const runtimeServices = new Set(RUNTIME_MODULES.flatMap((module) => module.service ? [module.service] : []));
  const runtimeSources = new Set(RUNTIME_MODULES.flatMap((module) => module.source_path ? [module.source_path] : []));
  const workerEntrypoints = Object.entries(packageJson.scripts)
    .filter(([name]) => /^run:.*worker$/u.test(name))
    .map(([, command]) => command.match(/scripts\/[\w.-]+\.ts/u)?.[0])
    .filter((script): script is string => Boolean(script));

  const controlPanelSettings = readFileSync("scripts/control-panel/settings.ts", "utf8");
  const controlPanelServices = [...controlPanelSettings.matchAll(/service: "([^"]+\.service)"/gu)]
    .map((match) => match[1]);

  assert.deepEqual(workerEntrypoints.filter((script) => !runtimeSources.has(script)).sort(), []);
  assert.deepEqual(controlPanelServices.filter((service) => !runtimeServices.has(service)).sort(), []);
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
  assert.equal(enhancedServices.includes("memory-xx-dream-worker.service"), false);
});

test("memory mode start plan skips full modules disabled by kill switches", () => {
  const services = buildRuntimeProfileStartServices("full", {
    MEMORY_XX_FASTPATH_ENABLED: "0",
    MEMORY_XX_LEXICAL_SIDECAR_ENABLED: "0",
    MEMORY_XX_RERANKER_ADAPTER_ENABLED: "0",
    MEMORY_XX_MEM0_EXTRACTOR_ENABLED: "0",
    MEMORY_XX_CONVERSATION_MONITOR_ENABLED: "0",
    MEMORY_XX_MARKDOWN_PROJECTION_ENABLED: "0",
    MEMORY_XX_DREAMING_ENABLED: "0",
    MEMORY_XX_CONTROL_PANEL_ENABLED: "0",
    MEMORY_XX_WRITE_TICKET_WORKER_ENABLED: "0",
    MEMORY_XX_QUALITY_RUNNER_ENABLED: "0",
    MEMORY_XX_GOVERNANCE_REPORT_ENABLED: "0",
  });

  assert.deepEqual(services, [
    "memory-xx-wrapper.service",
    "memory-xx-embedding-proxy-next.service",
    "memory-xx-qdrant-projector-worker.service",
    "memory-xx-qdrant-proxy-next.service",
    "memory-xx-cache-invalidation-worker.service",
    "memory-xx-maintenance.service",
    "memory-xx-consolidation.service",
    "memory-xx-detect.service",
    "memory-xx-auto-repair.service",
    "memory-xx-repair-report.service",
    "memory-xx-landing-scan.service",
    "memory-xx-canary-7d-report.service",
  ]);
});

test("memory mode stop plan keeps disabled profile services stoppable", () => {
  const services = buildRuntimeProfileStopServices("full", {
    MEMORY_XX_FASTPATH_ENABLED: "0",
    MEMORY_XX_LEXICAL_SIDECAR_ENABLED: "0",
    MEMORY_XX_RERANKER_ADAPTER_ENABLED: "0",
    MEMORY_XX_MEM0_EXTRACTOR_ENABLED: "0",
    MEMORY_XX_CONVERSATION_MONITOR_ENABLED: "0",
    MEMORY_XX_MARKDOWN_PROJECTION_ENABLED: "0",
    MEMORY_XX_DREAMING_ENABLED: "0",
    MEMORY_XX_CONTROL_PANEL_ENABLED: "0",
    MEMORY_XX_WRITE_TICKET_WORKER_ENABLED: "0",
  });

  assert.ok(services.includes("memory-xx-fastpath.service"));
  assert.ok(services.includes("memory-xx-lexical-sidecar.service"));
  assert.ok(services.includes("memory-xx-reranker-adapter-next.service"));
  assert.ok(services.includes("memory-xx-mem0-extractor.service"));
  assert.ok(services.includes("memory-xx-conversation-monitor-worker.service"));
  assert.ok(services.includes("memory-xx-dream-worker.service"));
  assert.ok(services.includes("memory-xx-control-panel.service"));
  assert.ok(services.includes("memory-xx-write-ticket-worker.service"));
});

test("memory mode payload separates enabled start services from disabled cleanup services", () => {
  const payload = buildMemoryModeStatusPayload("plan", "full", {
    env: {
      MEMORY_XX_FASTPATH_ENABLED: "0",
      MEMORY_XX_LEXICAL_SIDECAR_ENABLED: "0",
      MEMORY_XX_RERANKER_ADAPTER_ENABLED: "0",
      MEMORY_XX_MEM0_EXTRACTOR_ENABLED: "0",
      MEMORY_XX_CONVERSATION_MONITOR_ENABLED: "0",
      MEMORY_XX_MARKDOWN_PROJECTION_ENABLED: "0",
      MEMORY_XX_DREAMING_ENABLED: "0",
      MEMORY_XX_CONTROL_PANEL_ENABLED: "0",
      MEMORY_XX_WRITE_TICKET_WORKER_ENABLED: "0",
    },
    unitState: () => "inactive",
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "full");
  assert.equal(payload.start_services.includes("memory-xx-fastpath.service"), false);
  assert.equal(payload.start_services.includes("memory-xx-control-panel.service"), false);
  assert.equal(payload.start_services.includes("memory-xx-dream-worker.service"), false);
  assert.equal(payload.start_services.includes("memory-xx-write-ticket-worker.service"), false);
  assert.equal(payload.stop_services.includes("memory-xx-fastpath.service"), true);
  assert.equal(payload.stop_services.includes("memory-xx-dream-worker.service"), true);
  assert.equal(payload.stop_services.includes("memory-xx-write-ticket-worker.service"), true);
  assert.equal(payload.stop_services.includes("memory-xx-control-panel.service"), true);
});

test("doctor component classification treats disabled full modules as non-blocking", () => {
  const state = classifyDoctorComponentProfileState("fastpath", "full", {
    MEMORY_XX_FASTPATH_ENABLED: "0",
  });

  assert.deepEqual(state, {
    name: "fastpath",
    role: "required",
    enabled: false,
    blocks_profile: false,
    reason: "MEMORY_XX_FASTPATH_ENABLED=disabled",
  });
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

test("full-profile pluggable requirements can be disabled without blocking core", () => {
  const fullProfileOnlyRequiredModules = RUNTIME_MODULES.filter(
    (module) => module.required_in.includes("full") && !module.required_in.includes("core")
  );
  const missingEnvSwitch = fullProfileOnlyRequiredModules
    .filter((module) => !module.env_enabled)
    .map((module) => module.name);

  assert.deepEqual(missingEnvSwitch, []);

  const fullPluggableRequiredModules = fullProfileOnlyRequiredModules.filter((module) => module.env_enabled);
  const env = Object.fromEntries(fullPluggableRequiredModules.map((module) => [module.env_enabled, "0"]));

  assert.deepEqual(
    fullPluggableRequiredModules.map((module) => module.name).sort(),
    [
      "control_panel",
      "conversation_monitor",
      "fastpath",
      "governance_report",
      "lexical_sidecar",
      "llm_upstream",
      "mem0_extractor",
      "quality_runner",
      "reranker_adapter",
      "reranker_upstream",
    ].sort()
  );

  const fullStates = resolveRuntimeModuleStates("full", env);
  const coreSnapshot = buildRuntimeModuleSnapshot("core", env);

  for (const module of fullPluggableRequiredModules) {
    const state = fullStates.find((resolved) => resolved.module.name === module.name);
    assert.equal(state?.state, "disabled", `${module.name} should be disabled`);
    assert.equal(state?.blocks_profile, false, `${module.name} should not block when explicitly disabled`);
    assert.equal(coreSnapshot.states[module.name]?.blocks_profile, false, `${module.name} should not block core`);
  }
});

test("configured external upstreams require a health URL when enabled", () => {
  const states = resolveRuntimeModuleStates("full", {
    MEMORY_XX_LLM_UPSTREAM_ENABLED: "1",
    MEMORY_XX_LLM_UPSTREAM_HEALTH_URL: "",
    MEMORY_XX_MEM0_BASE_URL: "",
    MEMORY_INTELLIGENCE_BASE_URL: "",
  });

  const byName = new Map(states.map((state) => [state.module.name, state]));

  assert.equal(byName.get("llm_upstream")?.state, "missing_dependency");
  assert.equal(byName.get("llm_upstream")?.blocks_profile, true);
  assert.equal(byName.get("llm_upstream")?.reason, "health_url_unconfigured");
});

test("runtime module snapshot resolves upstream health URLs from injected env", () => {
  const snapshot = buildRuntimeModuleSnapshot("full", {
    MEMORY_XX_EMBEDDING_UPSTREAM_HEALTH_URL: "http://embedding.example/v1/models",
    MEMORY_XX_LLM_UPSTREAM_ENABLED: "1",
    MEMORY_XX_LLM_UPSTREAM_HEALTH_URL: "http://llm.example/v1/models",
    MEMORY_XX_RERANKER_UPSTREAM_ENABLED: "1",
    MEMORY_XX_RERANKER_UPSTREAM_HEALTH_URL: "http://reranker.example/v1/models",
  });

  assert.equal(snapshot.states.embedding_upstream?.health_url, "http://embedding.example/v1/models");
  assert.equal(snapshot.states.llm_upstream?.state, "enabled");
  assert.equal(snapshot.states.llm_upstream?.health_url, "http://llm.example/v1/models");
  assert.equal(snapshot.states.reranker_upstream?.health_url, "http://reranker.example/v1/models");
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

test("deploy systemd templates honor runtime module kill switches", () => {
  const missingGate: string[] = [];
  const serviceModules = new Map(RUNTIME_MODULES.flatMap((module) => module.service ? [[module.service, module]] : []));

  for (const [service, module] of serviceModules) {
    if (!module.env_enabled) continue;
    const unitPath = path.join("deploy", "systemd", service);
    try {
      const content = readFileSync(unitPath, "utf8");
      if (!content.includes(`runtime-module-enabled.ts ${module.name}`)) {
        missingGate.push(`${module.name}:${unitPath}`);
      }
    } catch {
      // Not every public unit has a deploy/systemd template.
    }
  }

  assert.deepEqual(missingGate, []);
});

test("public full-stack operations services are exposed as runtime modules", () => {
  const services = new Map(RUNTIME_MODULES.flatMap((module) => module.service ? [[module.service, module]] : []));
  const missing = [
    "memory-xx-auto-repair.service",
    "memory-xx-canary-7d-report.service",
    "memory-xx-cache-invalidation-worker.service",
    "memory-xx-consolidation.service",
    "memory-xx-detect.service",
    "memory-xx-landing-scan.service",
    "memory-xx-maintenance.service",
    "memory-xx-repair-report.service",
    "memory-xx-write-ticket-worker.service",
  ].filter((service) => !services.has(service));

  assert.deepEqual(missing, []);

  assert.equal(services.get("memory-xx-auto-repair.service")?.env_enabled, "MEMORY_XX_AUTO_REPAIR_ENABLED");
  assert.equal(services.get("memory-xx-cache-invalidation-worker.service")?.env_enabled, "MEMORY_XX_CACHE_INVALIDATION_WORKER_ENABLED");
  assert.equal(services.get("memory-xx-cache-invalidation-worker.service")?.source_path, "scripts/run-cache-invalidation-worker.ts");
  assert.equal(services.get("memory-xx-write-ticket-worker.service")?.env_enabled, "MEMORY_XX_WRITE_TICKET_WORKER_ENABLED");
  assert.equal(services.get("memory-xx-write-ticket-worker.service")?.source_path, "scripts/run-write-ticket-worker.ts");
  assert.equal(services.get("memory-xx-consolidation.service")?.source_path, "scripts/memory-consolidate.ts");
  assert.equal(services.get("memory-xx-maintenance.service")?.source_path, "scripts/maintenance.ts");
  assert.equal(services.get("memory-xx-landing-scan.service")?.command, "TMPDIR=/tmp npm run memory:landing-scan -- --json --write-report --max-files=200");
  assert.equal(services.get("memory-xx-canary-7d-report.service")?.command, "TMPDIR=/tmp npm run memory:canary-7d-report -- --json --write-report");
});
