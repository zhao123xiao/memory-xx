import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

import { FULL_STACK_CAPABILITIES } from "../app/full-stack-capabilities";
import { buildOpenSourcePreauditReport } from "../app/ops/open-source-release";
import { RUNTIME_MODULES } from "../app/runtime-modules";

async function collectPublicFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPublicFiles(fullPath, extensions));
    } else if (extensions.includes(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function composeServiceBlock(compose: string, service: string): string {
  const start = compose.search(new RegExp(`^  ${service}:$`, "m"));
  if (start < 0) return "";
  const rest = compose.slice(start + 1);
  const next = rest.search(new RegExp(`\\n  [a-z0-9-]+:$`, "m"));
  return next < 0 ? compose.slice(start) : compose.slice(start, start + 1 + next);
}

function composeServiceNames(compose: string): string[] {
  return [...compose.matchAll(/^  ([a-z0-9-]+):$/gmu)].map((match) => match[1]).filter(Boolean);
}

function duplicatedComposeEnvironmentKeys(compose: string): string[] {
  const duplicated: string[] = [];
  for (const service of composeServiceNames(compose)) {
    const block = composeServiceBlock(compose, service);
    const envStart = block.indexOf("    environment:\n");
    if (envStart < 0) continue;
    const envBlock = block.slice(envStart + "    environment:\n".length).split(/\n    [a-z_]+:/u)[0] ?? "";
    const keys = [...envBlock.matchAll(/^\s{6}([A-Z0-9_]+):/gmu)].map((match) => match[1]).filter(Boolean);
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) duplicated.push(`${service}:${key}`);
      seen.add(key);
    }
  }
  return duplicated;
}

test("open-source preaudit ignores local ignored build and runtime artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-xx-preaudit-"));
  await writeFile(path.join(root, "README.md"), "# memory-xx\n", "utf8");
  await mkdir(path.join(root, "dist", "app"), { recursive: true });
  await writeFile(path.join(root, "dist", "app", "generated.js"), "console.log('built');\n", "utf8");
  await mkdir(path.join(root, ".runtime"), { recursive: true });
  await writeFile(path.join(root, ".runtime", "state.json"), "{}\n", "utf8");

  const report = await buildOpenSourcePreauditReport({ root });

  assert.equal(report.ok, true);
  assert.deepEqual(report.blockers, []);
});

test("docker compose uses the public pgvector image and wrapper port 5100", async () => {
  const compose = await import("node:fs/promises").then((fs) => fs.readFile("docker-compose.yml", "utf8"));

  assert.match(compose, /pgvector\/pgvector:pg16/u);
  assert.doesNotMatch(compose, /pgvector\/pg16:pg16/u);
  assert.match(compose, /\$\{MEMORY_XX_WRAPPER_HOST_PORT:-5100\}:5100/u);
  assert.match(compose, /\$\{MEMORY_XX_EMBEDDING_PROXY_HOST_PORT:-5221\}:5221/u);
  assert.match(compose, /\$\{MEMORY_XX_DEV_EMBEDDING_HOST_PORT:-5222\}:5222/u);
  assert.match(compose, /\$\{MEMORY_XX_POSTGRES_HOST_PORT:-5432\}:5432/u);
  assert.match(compose, /\$\{MEMORY_XX_REDIS_HOST_PORT:-6379\}:6379/u);
  assert.match(compose, /\$\{MEMORY_XX_QDRANT_HOST_PORT:-6333\}:6333/u);
  assert.doesNotMatch(compose, /4001:4001/u);
});

test("docker compose keeps embedding provider defaults vendor-neutral", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const sidecarReadme = await readFile("sidecars/README.md", "utf8");

  assert.match(compose, /EMBEDDING_PROXY_UPSTREAM_BASE:-\$\{EMBEDDING_API_BASE:-https:\/\/embedding-provider\.example\/v1\}/u);
  assert.match(compose, /^  memory-xx-dev-embedding-upstream:$/mu);
  assert.match(compose, /profiles:\s*\n\s+- dev/u);
  assert.match(compose, /sidecars\/dev-embedding-upstream\/dev-embedding-upstream\.mjs/u);
  assert.match(compose, /MEMORY_XX_DEV_EMBEDDING_DIMS: \$\{MEMORY_XX_DEV_EMBEDDING_DIMS:-\$\{EMBEDDING_DIMS:-4096\}\}/u);
  assert.equal(packageJson.scripts["memory:dev-embedding-upstream"], "node sidecars/dev-embedding-upstream/dev-embedding-upstream.mjs");
  assert.equal(packageJson.scripts["memory:dev-reranker-upstream"], "node sidecars/dev-reranker-upstream/dev-reranker-upstream.mjs");
  assert.equal(packageJson.scripts["memory:dev-chat-upstream"], "node sidecars/dev-chat-upstream/dev-chat-upstream.mjs");
  assert.match(compose, /^  memory-xx-dev-reranker-upstream:$/mu);
  assert.match(compose, /^  memory-xx-dev-chat-upstream:$/mu);
  assert.match(composeServiceBlock(compose, "memory-xx-dev-reranker-upstream"), /profiles:\s*\n\s+- dev/u);
  assert.match(composeServiceBlock(compose, "memory-xx-dev-chat-upstream"), /profiles:\s*\n\s+- dev/u);
  assert.match(compose, /sidecars\/dev-reranker-upstream\/dev-reranker-upstream\.mjs/u);
  assert.match(compose, /sidecars\/dev-chat-upstream\/dev-chat-upstream\.mjs/u);
  assert.match(composeServiceBlock(compose, "memory-xx-reranker-adapter"), /memory-xx-dev-reranker-upstream:8084\/v3\/rerank/u);
  assert.match(composeServiceBlock(compose, "memory-xx-mem0-extractor"), /memory-xx-dev-chat-upstream:5223\/v1/u);
  assert.match(sidecarReadme, /dev-embedding-upstream\/dev-embedding-upstream\.mjs/u);
  assert.match(sidecarReadme, /dev-reranker-upstream\/dev-reranker-upstream\.mjs/u);
  assert.match(sidecarReadme, /dev-chat-upstream\/dev-chat-upstream\.mjs/u);
  assert.match(sidecarReadme, /npm run memory:dev-embedding-upstream/u);
  assert.match(sidecarReadme, /npm run memory:dev-reranker-upstream/u);
  assert.match(sidecarReadme, /npm run memory:dev-chat-upstream/u);
  assert.doesNotMatch(compose, /scnet\.cn|超算互联网|0\.1\s*\/\s*百万\s*token/u);
});

test("docker compose includes the core Qdrant projector worker", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");

  assert.match(compose, /^  memory-xx-qdrant-projector-worker:$/mu);
  assert.match(compose, /scripts\/run-qdrant-projector-worker\.ts/u);
  assert.match(compose, /MEMORY_XX_QDRANT_PROJECTOR_STATUS_FILE: \/app\/\.runtime\/qdrant-projector-worker\.status\.json/u);
  assert.match(compose, /^  memory-xx-migrate:$/mu);
  assert.match(compose, /command: \["node", "--import", "tsx", "scripts\/migrate\.ts"\]/u);
  assert.match(compose, /memory-xx-migrate:\s*\n\s+condition: service_completed_successfully/u);
  assert.match(compose, /^  memory-xx:[\s\S]*?MEMORY_XX_ADMIN_TOKEN: \$\{MEMORY_XX_ADMIN_TOKEN:-\$\{MEMORY_XX_API_TOKEN:-changeme\}\}[\s\S]*?^    depends_on:/mu);
  assert.match(compose, /memory-xx-embedding-proxy:\s*\n\s+condition: service_started/u);
  assert.match(compose, /qdrant:\s*\n\s+condition: service_started/u);
});

test("docker compose keeps core long-running services restartable", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");

  for (const service of ["memory-xx", "memory-xx-embedding-proxy", "memory-xx-qdrant-projector-worker"]) {
    assert.match(composeServiceBlock(compose, service), /restart: unless-stopped/u, service);
  }
  assert.match(composeServiceBlock(compose, "memory-xx-migrate"), /restart: "no"/u);
});

test("docker compose pluggable services expose host ports through environment overrides", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const expectedPorts = new Map([
    ["memory-xx-fastpath", "${MEMORY_XX_FASTPATH_HOST_PORT:-5200}:5200"],
    ["memory-xx-lexical-sidecar", "${MEMORY_XX_LEXICAL_HOST_PORT:-5210}:5210"],
    ["memory-xx-qdrant-proxy", "${MEMORY_XX_QDRANT_PROXY_HOST_PORT:-6334}:6334"],
    ["memory-xx-reranker-adapter", "${MEMORY_XX_RERANKER_ADAPTER_HOST_PORT:-8085}:8085"],
    ["memory-xx-control-panel", "${MEMORY_XX_CONTROL_PANEL_HOST_PORT:-5310}:5310"],
    ["memory-xx-mem0-extractor", "${MEMORY_XX_MEM0_EXTRACTOR_HOST_PORT:-5220}:5220"],
  ]);

  for (const [service, mapping] of expectedPorts) {
    const block = composeServiceBlock(compose, service);
    assert.ok(block.includes(mapping), `${service} should use ${mapping}`);
  }
});

test("public env and docs document pluggable compose host port overrides", async () => {
  const publicText = [
    await readFile(".env.example", "utf8"),
    await readFile("configs/memory-xx-wrapper.env.example", "utf8"),
    await readFile("README.md", "utf8"),
    await readFile("docs/quickstart.zh-CN.md", "utf8"),
  ].join("\n");
  const hostPortVars = [
    "MEMORY_XX_FASTPATH_HOST_PORT",
    "MEMORY_XX_LEXICAL_HOST_PORT",
    "MEMORY_XX_QDRANT_PROXY_HOST_PORT",
    "MEMORY_XX_RERANKER_ADAPTER_HOST_PORT",
    "MEMORY_XX_CONTROL_PANEL_HOST_PORT",
    "MEMORY_XX_MEM0_EXTRACTOR_HOST_PORT",
  ];

  const missing = hostPortVars.filter((name) => !publicText.includes(name));

  assert.deepEqual(missing, []);
});

test("docker compose does not let non-wrapper services inherit wrapper healthcheck", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const ownHealthchecks = new Map([
    ["memory-xx-embedding-proxy", "http://127.0.0.1:5221/health"],
    ["memory-xx-dev-embedding-upstream", "http://127.0.0.1:5222/health"],
    ["memory-xx-fastpath", "http://127.0.0.1:5200/health"],
    ["memory-xx-lexical-sidecar", "http://127.0.0.1:5210/health"],
    ["memory-xx-qdrant-proxy", "http://127.0.0.1:6334/health"],
    ["memory-xx-reranker-adapter", "http://127.0.0.1:8085/health"],
    ["memory-xx-control-panel", "http://127.0.0.1:5310/health"],
    ["memory-xx-mem0-extractor", "http://127.0.0.1:5220/health"],
  ]);
  const healthcheckDisabled = [
    "memory-xx-migrate",
    "memory-xx-qdrant-projector-worker",
    "memory-xx-conversation-monitor-worker",
    "memory-xx-markdown-projection",
    "memory-xx-dream-worker",
    "memory-xx-cache-invalidation-worker",
    "memory-xx-write-ticket-worker",
    "memory-xx-maintenance",
    "memory-xx-consolidation",
    "memory-xx-detect",
    "memory-xx-auto-repair",
    "memory-xx-repair-report",
    "memory-xx-landing-scan",
    "memory-xx-canary-7d-report",
    "memory-xx-quality-runner",
    "memory-xx-governance-report",
  ];

  for (const [service, healthUrl] of ownHealthchecks) {
    const block = composeServiceBlock(compose, service);
    assert.match(block, /healthcheck:\s*\n\s+test:/u, service);
    assert.ok(block.includes(healthUrl), service);
    assert.doesNotMatch(block, /127\.0\.0\.1:5100\/live/u, service);
  }
  for (const service of healthcheckDisabled) {
    assert.match(composeServiceBlock(compose, service), /healthcheck:\s*\n\s+disable: true/u, service);
  }
});

test("docker compose service environments do not duplicate keys", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");

  assert.deepEqual(duplicatedComposeEnvironmentKeys(compose), []);
});

test("public compose core smoke is exposed as an open-source verification entrypoint", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const readme = await readFile("README.md", "utf8");
  const quickstart = await readFile("docs/quickstart.zh-CN.md", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const script = await readFile("scripts/compose-core-smoke.ts", "utf8");

  assert.equal(packageJson.scripts["smoke:compose-core"], "node --import tsx scripts/compose-core-smoke.ts");
  assert.equal(packageJson.scripts["smoke:compose-profile-live"], "node --import tsx scripts/compose-core-smoke.ts --live");
  assert.match(packageJson.scripts["verify:open-source"], /npm run smoke:compose-core/u);
  assert.match(readme, /npm run smoke:compose-core/u);
  assert.match(readme, /npm run smoke:compose-profile-live/u);
  assert.match(quickstart, /npm run smoke:compose-core/u);
  assert.match(operations, /npm run smoke:compose-profile-live/u);
  assert.match(script, /memory-xx-qdrant-projector-worker/u);
  assert.match(script, /enhanced\/full services must stay behind profiles/u);
});

test("docker compose exposes pluggable enhanced and full-stack services as profiles", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");

  for (const service of [
    "memory-xx-embedding-proxy",
    "memory-xx-fastpath",
    "memory-xx-lexical-sidecar",
    "memory-xx-qdrant-proxy",
    "memory-xx-reranker-adapter",
    "memory-xx-mem0-extractor",
    "memory-xx-conversation-monitor-worker",
    "memory-xx-markdown-projection",
    "memory-xx-dream-worker",
    "memory-xx-cache-invalidation-worker",
    "memory-xx-write-ticket-worker",
    "memory-xx-control-panel",
  ]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "mu"), `missing compose service ${service}`);
  }

  assert.match(compose, /profiles:\s*\n\s+- enhanced/u);
  assert.match(compose, /profiles:\s*\n\s+- full/u);
  assert.match(compose, /sidecars\/fastpath\/fastpath\.mjs/u);
  assert.match(compose, /sidecars\/lexical-sidecar\/lexical-sidecar\.mjs/u);
  assert.match(compose, /scripts\/run-conversation-monitor-worker\.ts/u);
  assert.match(compose, /scripts\/run-markdown-projection-worker\.ts/u);
  assert.match(compose, /scripts\/runtime-module-enabled\.ts markdown_projection/u);
  assert.match(compose, /scripts\/run-dream-worker\.ts/u);
  assert.match(compose, /scripts\/runtime-module-enabled\.ts memory_dreaming/u);
  assert.match(compose, /MEMORY_XX_DREAMING_ENABLED: \$\{MEMORY_XX_DREAMING_ENABLED:-0\}/u);
  assert.match(compose, /scripts\/runtime-module-enabled\.ts cache_invalidation_worker/u);
  assert.match(compose, /MEMORY_XX_CACHE_INVALIDATION_STATUS_FILE: \/app\/\.runtime\/cache-invalidation-worker\.status\.json/u);
  assert.match(compose, /scripts\/runtime-module-enabled\.ts write_ticket_worker/u);
  assert.match(compose, /scripts\/run-write-ticket-worker\.ts/u);
  assert.match(compose, /MEMORY_XX_WRITE_TICKET_WORKER_STATUS_FILE: \/app\/\.runtime\/write-ticket-worker\.status\.json/u);
  assert.match(compose, /scripts\/memory-control-panel\.ts/u);
  assert.match(compose, /MEMORY_XX_RUNTIME_PROFILE: \$\{MEMORY_XX_RUNTIME_PROFILE:-core\}/u);
  assert.doesNotMatch(compose, /MEMORY_XX_FASTPATH_ENABLED: \$\{MEMORY_XX_FASTPATH_ENABLED:-true\}/u);
});

test("docker compose includes enhanced expected services in the enhanced profile", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const enhancedExpectedServices = [
    "memory-xx-qdrant-proxy",
    "memory-xx-fastpath",
    "memory-xx-lexical-sidecar",
    "memory-xx-reranker-adapter",
    "memory-xx-mem0-extractor",
    "memory-xx-conversation-monitor-worker",
    "memory-xx-control-panel",
  ];

  for (const service of enhancedExpectedServices) {
    assert.match(composeServiceBlock(compose, service), /profiles:\s*\n\s+- enhanced\s*\n\s+- full/u, service);
  }
});

test("docker compose full profile includes enhanced services required by full runtime", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const fullRequiredEnhancedServices = [
    "memory-xx-fastpath",
    "memory-xx-lexical-sidecar",
    "memory-xx-qdrant-proxy",
    "memory-xx-reranker-adapter",
    "memory-xx-control-panel",
  ];

  for (const service of fullRequiredEnhancedServices) {
    const block = composeServiceBlock(compose, service);
    assert.match(block, /profiles:\s*\n\s+- enhanced\s*\n\s+- full/u, `${service} must run under full profile`);
  }
});

test("docker compose pluggable profile services honor runtime module switches", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const modules = [
    ["memory-xx-fastpath", "fastpath", "MEMORY_XX_FASTPATH_ENABLED"],
    ["memory-xx-lexical-sidecar", "lexical_sidecar", "MEMORY_XX_LEXICAL_SIDECAR_ENABLED"],
    ["memory-xx-qdrant-proxy", "qdrant_proxy", "MEMORY_XX_QDRANT_PROXY_ENABLED"],
    ["memory-xx-reranker-adapter", "reranker_adapter", "MEMORY_XX_RERANKER_ADAPTER_ENABLED"],
    ["memory-xx-mem0-extractor", "mem0_extractor", "MEMORY_XX_MEM0_EXTRACTOR_ENABLED"],
    ["memory-xx-conversation-monitor-worker", "conversation_monitor", "MEMORY_XX_CONVERSATION_MONITOR_ENABLED"],
    ["memory-xx-control-panel", "control_panel", "MEMORY_XX_CONTROL_PANEL_ENABLED"],
  ] as const;

  for (const [service, moduleName, envName] of modules) {
    assert.match(compose, new RegExp(`^  ${service}:$`, "mu"), `missing compose service ${service}`);
    assert.match(compose, new RegExp(`scripts/runtime-module-enabled\\.ts ${moduleName}`, "u"), `missing runtime switch for ${service}`);
    assert.equal(compose.includes(`${envName}: \${${envName}:-0}`), true, `missing disabled default env for ${service}`);
  }
});

test("docker compose wrapper receives pluggable runtime module switches", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const wrapper = composeServiceBlock(compose, "memory-xx");
  const envNames = [
    "MEMORY_XX_QDRANT_PROXY_ENABLED",
    "MEMORY_XX_FASTPATH_ENABLED",
    "MEMORY_XX_LEXICAL_SIDECAR_ENABLED",
    "MEMORY_XX_RERANKER_UPSTREAM_ENABLED",
    "MEMORY_XX_RERANKER_ADAPTER_ENABLED",
    "MEMORY_XX_LLM_UPSTREAM_ENABLED",
    "MEMORY_XX_MEM0_EXTRACTOR_ENABLED",
    "MEMORY_XX_CONVERSATION_MONITOR_ENABLED",
    "MEMORY_XX_CONTROL_PANEL_ENABLED",
    "MEMORY_XX_MARKDOWN_PROJECTION_ENABLED",
    "MEMORY_XX_DREAMING_ENABLED",
    "MEMORY_XX_CACHE_INVALIDATION_WORKER_ENABLED",
    "MEMORY_XX_WRITE_TICKET_WORKER_ENABLED",
    "MEMORY_XX_MAINTENANCE_ENABLED",
    "MEMORY_XX_CONSOLIDATION_ENABLED",
    "MEMORY_XX_RUNTIME_ISSUE_DETECTION_ENABLED",
    "MEMORY_XX_AUTO_REPAIR_ENABLED",
    "MEMORY_XX_REPAIR_REPORT_ENABLED",
    "MEMORY_XX_LANDING_SCAN_ENABLED",
    "MEMORY_XX_CANARY_7D_REPORT_ENABLED",
    "MEMORY_XX_QUALITY_RUNNER_ENABLED",
    "MEMORY_XX_GOVERNANCE_REPORT_ENABLED",
  ];

  for (const envName of envNames) {
    assert.equal(wrapper.includes(`${envName}: \${${envName}:-0}`), true, envName);
  }
});

test("docker compose passes runtime profile into pluggable module guards", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const services = [
    "memory-xx-fastpath",
    "memory-xx-lexical-sidecar",
    "memory-xx-qdrant-proxy",
    "memory-xx-reranker-adapter",
    "memory-xx-mem0-extractor",
    "memory-xx-conversation-monitor-worker",
    "memory-xx-markdown-projection",
    "memory-xx-dream-worker",
    "memory-xx-cache-invalidation-worker",
    "memory-xx-write-ticket-worker",
    "memory-xx-control-panel",
    "memory-xx-maintenance",
    "memory-xx-consolidation",
    "memory-xx-detect",
    "memory-xx-auto-repair",
    "memory-xx-repair-report",
    "memory-xx-landing-scan",
    "memory-xx-canary-7d-report",
  ];
  const missing: string[] = [];

  for (const service of services) {
    const block = composeServiceBlock(compose, service);
    if (!block.includes("scripts/runtime-module-enabled.ts")) continue;
    if (!block.includes("MEMORY_XX_RUNTIME_PROFILE: ${MEMORY_XX_RUNTIME_PROFILE:-core}")) {
      missing.push(service);
    }
  }

  assert.deepEqual(missing, []);
});

test("docker compose guarded pluggable modules do not restart successful disabled exits", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const restarted: string[] = [];
  for (const module of RUNTIME_MODULES) {
    if (!module.startable || !module.service || !module.env_enabled) continue;
    const service = module.service
      .replace(/\.service$/u, "")
      .replace(/-next$/u, "")
      .replace(/-worker$/u, "");
    const block = composeServiceBlock(compose, service);
    if (!block.includes("scripts/runtime-module-enabled.ts")) continue;
    if (block.includes("restart: unless-stopped") || block.includes("restart: always")) restarted.push(service);
  }

  assert.deepEqual(restarted, []);
});

test("docker compose restart policy matches pluggable module lifecycle", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const longRunning = [
    "memory-xx-fastpath",
    "memory-xx-lexical-sidecar",
    "memory-xx-qdrant-proxy",
    "memory-xx-reranker-adapter",
    "memory-xx-mem0-extractor",
    "memory-xx-conversation-monitor-worker",
    "memory-xx-dream-worker",
    "memory-xx-cache-invalidation-worker",
    "memory-xx-write-ticket-worker",
    "memory-xx-control-panel",
  ];
  const oneShot = [
    "memory-xx-markdown-projection",
    "memory-xx-maintenance",
    "memory-xx-consolidation",
    "memory-xx-detect",
    "memory-xx-auto-repair",
    "memory-xx-repair-report",
    "memory-xx-landing-scan",
    "memory-xx-canary-7d-report",
  ];

  for (const service of longRunning) {
    assert.match(composeServiceBlock(compose, service), /restart: on-failure/u, service);
  }
  for (const service of oneShot) {
    assert.match(composeServiceBlock(compose, service), /restart: "no"/u, service);
  }
});

test("docker compose exposes full-stack operations modules with runtime switches", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const modules = [
    ["memory-xx-maintenance", "maintenance_orchestrator"],
    ["memory-xx-consolidation", "temporal_consolidation"],
    ["memory-xx-detect", "runtime_issue_detection"],
    ["memory-xx-auto-repair", "auto_repair"],
    ["memory-xx-repair-report", "repair_report"],
    ["memory-xx-landing-scan", "landing_scan"],
    ["memory-xx-canary-7d-report", "canary_7d_report"],
    ["memory-xx-quality-runner", "quality_runner"],
    ["memory-xx-governance-report", "governance_report"],
  ] as const;

  for (const [service, moduleName] of modules) {
    assert.match(compose, new RegExp(`^  ${service}:$`, "mu"), `missing compose service ${service}`);
    assert.match(compose, new RegExp(`scripts/runtime-module-enabled\\.ts ${moduleName}`, "u"), `missing runtime switch for ${moduleName}`);
  }
});

test("Dockerfile includes source needed by public pluggable modules", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");

  assert.match(dockerfile, /COPY sidecars\/ sidecars\//u);
  assert.match(dockerfile, /COPY scripts\/ scripts\//u);
  assert.match(dockerfile, /COPY app\/ app\//u);
  assert.match(dockerfile, /COPY src\/ src\//u);
  assert.match(dockerfile, /COPY tsconfig\.json \.\//u);
  assert.match(dockerfile, /EXPOSE .*5222.*5223.*8084.*8085/u);
});

test("Dockerfile builder copies every TypeScript source root before build", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8")) as { readonly include?: readonly string[] };
  const beforeBuild = dockerfile.split(/RUN npm run build/u)[0] ?? "";
  const missing: string[] = [];

  for (const include of tsconfig.include ?? []) {
    const root = include.split("/")[0];
    if (!root || root.includes("*")) continue;
    const copyPattern = new RegExp(`COPY\\s+${root}/\\s+${root}/`, "u");
    if (!copyPattern.test(beforeBuild)) missing.push(root);
  }

  assert.deepEqual(missing, []);
});

test("Dockerfile builder copies scripts used by TypeScript test imports before build", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const beforeBuild = dockerfile.split(/RUN npm run build/u)[0] ?? "";

  assert.match(beforeBuild, /COPY scripts\/ scripts\//u);
});

test("Dockerfile runtime installs locked production dependencies without ad-hoc tsx reinstall", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };

  assert.equal(Boolean(packageJson.dependencies?.tsx), true);
  assert.match(dockerfile, /RUN npm ci --omit=dev/u);
  assert.doesNotMatch(dockerfile, /npm install --no-save tsx/u);
});

test("Dockerfile includes compose file needed by public compose smoke", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");

  assert.match(dockerfile, /COPY docker-compose\.yml \.\//u);
});

test("public env examples use the same default wrapper port", async () => {
  const fs = await import("node:fs/promises");
  const rootEnv = await fs.readFile(".env.example", "utf8");
  const wrapperEnv = await fs.readFile("configs/memory-xx-wrapper.env.example", "utf8");

  assert.match(rootEnv, /^MEMORY_XX_WRAPPER_PORT=5100$/mu);
  assert.match(wrapperEnv, /^MEMORY_XX_WRAPPER_PORT=5100$/mu);
});

test("public docs and config templates use memory-xx env and API names", async () => {
  const files = [
    "README.md",
    ".env.example",
    "configs/README.md",
    "configs/memory-xx.env.example",
    "configs/memory-xx-wrapper.env.example",
    "configs/memory-xx-qdrant-projector-worker.env.example",
    "docker-compose.yml",
    "docs/api.md",
    "docs/migration-rollback-playbook.md",
    "docs/quickstart.zh-CN.md",
    "docs/runtime-profiles.md",
    "docs/vector-runtime.zh-CN.md",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/MEMORY_V2_|\/api\/memory\/v2/u.test(content)) stale.push(file);
  }

  assert.deepEqual(stale, []);
});

test("public sources do not retain memory-xx-next project naming", async () => {
  const files = [
    ...(await collectPublicFiles("app", [".ts"])),
    ...(await collectPublicFiles("scripts", [".ts", ".sh", ".ps1"])).filter((file) => file !== "scripts/check-hardcoded-paths.ts"),
    ...(await collectPublicFiles("docs", [".md"])),
    ...(await collectPublicFiles("tests", [".ts"])).filter((file) => file !== "tests/open-source-readiness.test.ts"),
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/memory-xx-next/u.test(content)) stale.push(file);
  }

  assert.deepEqual(stale.sort(), []);
});

test("public runtime defaults use generic memory-xx actor names", async () => {
  const files = [
    "app/server/cli.ts",
    "app/server/http-request-builders.ts",
    "app/server/http-review-handler.ts",
    "app/server/http-orchestrator-handler.ts",
    "app/mcp/mcp-server.ts",
    "app/skills/builtins/smart-write.ts",
    "app/governance/policy-corpus.ts",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/\bklee\b/u.test(content)) stale.push(file);
  }

  assert.deepEqual(stale, []);
});

test("public docker profile docs set matching runtime profile", async () => {
  const files = ["docs/quickstart.zh-CN.md", "docs/operations.md", "docs/operations.zh-CN.md"] as const;
  const missing: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (!/MEMORY_XX_RUNTIME_PROFILE=enhanced\s+docker-compose --profile enhanced up/u.test(content)) {
      missing.push(`${file}:enhanced`);
    }
    if (!/MEMORY_XX_RUNTIME_PROFILE=full\s+docker-compose --profile full up/u.test(content)) {
      missing.push(`${file}:full`);
    }
    if (!/full[` ]+(?:会包含|includes) (?:enhanced|the enhanced)/iu.test(content)) {
      missing.push(`${file}:full_includes_enhanced`);
    }
  }

  assert.deepEqual(missing, []);
});

test("public systemd bundle provides the unit name used by scripts", async () => {
  const fs = await import("node:fs/promises");
  const wrapper = await fs.readFile("systemd/memory-xx-wrapper.service", "utf8");
  const projector = await fs.readFile("systemd/memory-xx-qdrant-projector-worker.service", "utf8");

  assert.match(wrapper, /^Description=memory-xx wrapper$/mu);
  assert.match(projector, /^Description=memory-xx Qdrant projector worker$/mu);
  assert.match(wrapper, /ExecStart=.*wrapper-entry\.mjs/u);
  await assert.rejects(
    () => fs.stat("systemd/openclaw-memory-xx-wrapper.service"),
    /ENOENT/u
  );
});

test("public env templates use memory-xx config paths rather than OpenClaw-owned paths", async () => {
  const files = [
    "configs/memory-xx-wrapper.env.example",
    "configs/memory-xx-qdrant-projector-worker.env.example",
  ];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.match(content, /\.config\/memory-xx\//u);
    assert.doesNotMatch(content, /\.config\/openclaw\//u);
  }
});

test("README documents required session roots and API embedding option", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /MEMORY_XX_CODEX_SESSION_ROOTS/u);
  assert.match(readme, /MEMORY_XX_CLAUDE_SESSION_ROOTS/u);
  assert.match(readme, /MEMORY_XX_OPENCLAW_SESSION_ROOTS/u);
  assert.match(readme, /OpenClaw 是可选 adapter/u);
  assert.match(readme, /--required-source=openclaw_session/u);
  assert.match(readme, /https:\/\/embedding-provider\.example\/v1/u);
  assert.doesNotMatch(readme, /scnet\.cn|超算互联网|0\.1\s*\/\s*百万\s*token/u);
  assert.match(readme, /MEMORY_XX_SCOPE_POLICY_MODE=single_user/u);
  assert.match(readme, /sidecar/u);
});

test("public canary docs keep optional conversation adapters opt-in", async () => {
  const canary = await readFile("docs/canary.zh-CN.md", "utf8");
  const quickstart = await readFile("docs/quickstart.zh-CN.md", "utf8");

  assert.match(canary, /codex_session/u);
  assert.match(canary, /claude_code_session/u);
  assert.match(canary, /memory:landing-scan -- --json --write-report --required-source=openclaw_session/u);
  assert.match(canary, /--required-source=openclaw_session/u);
  assert.match(quickstart, /OpenClaw 是可选 adapter/u);
});

test("public harness keeps OpenClaw integration opt-in", async () => {
  const aggregator = await readFile("scripts/test-harness/reports/aggregator.ts", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const operationsZh = await readFile("docs/operations.zh-CN.md", "utf8");

  assert.match(aggregator, /export function buildHarnessLayerScripts/u);
  assert.match(aggregator, /--require-openclaw/u);
  assert.match(aggregator, /MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION/u);
  assert.match(aggregator, /required: requireOpenClaw/u);
  assert.doesNotMatch(aggregator, /name:\s*"OpenClaw Integration"[\s\S]{0,120}required:\s*true/u);
  assert.match(operations, /L7.*optional OpenClaw adapter/us);
  assert.match(operations, /--require-openclaw/u);
  assert.match(operations, /MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION=1/u);
  assert.match(operationsZh, /L7.*可选 OpenClaw adapter/us);
  assert.match(operationsZh, /--require-openclaw/u);
  assert.match(operationsZh, /MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION=1/u);
});

test("public operations docs and generic status tools do not require OpenClaw", async () => {
  const operations = await readFile("docs/operations.md", "utf8");
  const backup = await readFile("scripts/memory-backup.ts", "utf8");
  const status = await readFile("scripts/memory-status.ts", "utf8");

  assert.doesNotMatch(operations, /OpenClaw must use/u);
  assert.doesNotMatch(operations, /OpenClaw is part of the target deployment/u);
  assert.doesNotMatch(operations, /openclaw memory status --deep/u);
  assert.doesNotMatch(backup, /openclaw-memory/u);
  assert.doesNotMatch(status, /openclaw-memory/u);
});

test("public quickstart and env template keep embedding provider vendor-neutral", async () => {
  const quickstart = await readFile("docs/quickstart.zh-CN.md", "utf8");
  const envExample = await readFile(".env.example", "utf8");

  assert.match(quickstart, /https:\/\/embedding-provider\.example\/v1/u);
  assert.match(quickstart, /memory-xx-dev-embedding-upstream/u);
  assert.match(quickstart, /npm run memory:dev-embedding-upstream/u);
  assert.match(quickstart, /--profile dev/u);
  assert.doesNotMatch(quickstart, /scnet\.cn|超算互联网|0\.1\s*\/\s*百万\s*token/u);
  assert.match(envExample, /^EMBEDDING_API_BASE=https:\/\/embedding-provider\.example\/v1$/mu);
  assert.doesNotMatch(envExample, /scnet\.cn/u);
});

test("public dev embedding smoke uses the schema-compatible 4096 dimensions", async () => {
  const files = [
    "README.md",
    "docs/quickstart.zh-CN.md",
    "sidecars/dev-embedding-upstream/README.md",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/MEMORY_XX_DEV_EMBEDDING_DIMS=384|EMBEDDING_DIMS=384/u.test(content)) {
      stale.push(file);
    }
  }

  assert.deepEqual(stale, []);
});

test("public repository includes source entries for pluggable full-stack sidecars", async () => {
  const files = [
    "sidecars/embedding-proxy/embedding-proxy.mjs",
    "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs",
    "sidecars/reranker-adapter/reranker-adapter.mjs",
    "sidecars/mem0-extractor/extractor.py",
    "sidecars/fastpath/fastpath.mjs",
    "sidecars/lexical-sidecar/lexical-sidecar.mjs",
    "sidecars/dev-embedding-upstream/dev-embedding-upstream.mjs",
    "sidecars/dev-reranker-upstream/dev-reranker-upstream.mjs",
    "sidecars/dev-chat-upstream/dev-chat-upstream.mjs",
    "sidecars/dev-embedding-upstream/README.md",
  ];
  const missing: string[] = [];
  for (const file of files) {
    try {
      await readFile(file, "utf8");
    } catch {
      missing.push(file);
    }
  }

  assert.deepEqual(missing, []);
});

test("public repository includes markdown projection as a pluggable full-stack module", async () => {
  const files = [
    "app/projection/index.ts",
    "app/projection/runner.ts",
    "app/projection/writer/diff-guard.ts",
    "app/projection/writer/atomic-write.ts",
    "app/source-mode.ts",
    "scripts/source-mode.ts",
    "scripts/run-projection-shadow-r3.ts",
    "scripts/run-markdown-projection-worker.ts",
    "scripts/markdown-projection-smoke.ts",
    "systemd/memory-xx-markdown-projection.service",
    "tests/projection-foundation.test.ts",
    "tests/markdown-projection-smoke.test.ts",
  ];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2|loadMemoryV2/u.test(content)) stale.push(file);
    } catch {
      missing.push(file);
    }
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const runtimeModules = await readFile("app/runtime-modules.ts", "utf8");

  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
  assert.equal(packageJson.scripts["memory:source-mode"], "node --import tsx scripts/source-mode.ts");
  assert.equal(packageJson.scripts["shadow:projection"], "node --import tsx scripts/run-projection-shadow-r3.ts");
  assert.equal(packageJson.scripts["run:markdown-projection-worker"], "node --import tsx scripts/run-markdown-projection-worker.ts");
  assert.match(runtimeModules, /name: "markdown_projection"/u);
  assert.match(runtimeModules, /MEMORY_XX_MARKDOWN_PROJECTION_ENABLED/u);
  assert.match(runtimeModules, /startable: true/u);
});

test("public repository includes memory dreaming as a pluggable full-stack module", async () => {
  const files = [
    "app/dream/index.ts",
    "app/dream/dream-worker.ts",
    "app/dream/dream-scheduler.ts",
    "app/dream/dream-tasks.ts",
    "scripts/run-dream-worker.ts",
    "scripts/memory-dreaming-smoke.ts",
    "systemd/memory-xx-dream-worker.service",
    "tests/dream.test.ts",
    "tests/memory-dreaming-smoke.test.ts",
  ];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2/u.test(content)) stale.push(file);
    } catch {
      missing.push(file);
    }
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const capabilities = await readFile("app/full-stack-capabilities.ts", "utf8");

  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
  assert.equal(packageJson.scripts["run:dream-worker"], "node --import tsx scripts/run-dream-worker.ts");
  assert.equal(packageJson.scripts["smoke:memory-dreaming"], "node --import tsx scripts/memory-dreaming-smoke.ts");
  assert.match(await readFile("systemd/memory-xx-dream-worker.service", "utf8"), /scripts\/runtime-module-enabled\.ts memory_dreaming/u);
  assert.match(capabilities, /name: "memory_dreaming"/u);
  assert.match(capabilities, /MEMORY_XX_DREAMING_ENABLED/u);
  assert.match(capabilities, /scripts\/run-dream-worker\.ts/u);
  assert.match(capabilities, /scripts\/memory-dreaming-smoke\.ts/u);
  const dreamWorker = await readFile("scripts/run-dream-worker.ts", "utf8");
  assert.match(dreamWorker, /MEMORY_XX_DREAMING_ENABLED/u);
  assert.doesNotMatch(dreamWorker, /MEMORY_XX_DREAM_ENABLED/u);
});

test("public repository exposes knowledge graph smoke for enhanced graph modules", async () => {
  const files = [
    "app/knowledge/service.ts",
    "app/intelligence/graph-extraction.ts",
    "app/recall/retrievers/graph-retriever.ts",
    "app/code-graph.ts",
    "scripts/memory-knowledge-md.ts",
    "scripts/graph-health.ts",
    "scripts/memory-graph-report.ts",
    "scripts/memory-code-graph.ts",
    "scripts/knowledge-graph-smoke.ts",
    "tests/knowledge-graph-smoke.test.ts",
  ];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2/u.test(content)) stale.push(file);
    } catch {
      missing.push(file);
    }
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const capabilities = await readFile("app/full-stack-capabilities.ts", "utf8");
  const readme = await readFile("README.md", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const operationsZh = await readFile("docs/operations.zh-CN.md", "utf8");
  const moduleCatalog = await readFile("docs/module-catalog.md", "utf8");

  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
  assert.equal(packageJson.scripts["smoke:knowledge-graph"], "node --import tsx scripts/knowledge-graph-smoke.ts");
  assert.match(packageJson.scripts["verify:open-source"], /tests\/knowledge-graph-smoke\.test\.ts/u);
  assert.match(capabilities, /name: "knowledge_ingest"[\s\S]*scripts\/knowledge-graph-smoke\.ts/u);
  assert.match(capabilities, /name: "memory_knowledge_graph"[\s\S]*scripts\/knowledge-graph-smoke\.ts/u);
  assert.match(readme, /TMPDIR=\/tmp npm run smoke:knowledge-graph/u);
  assert.match(operations, /TMPDIR=\/tmp npm run smoke:knowledge-graph/u);
  assert.match(operationsZh, /TMPDIR=\/tmp npm run smoke:knowledge-graph/u);
  assert.match(moduleCatalog, /smoke:knowledge-graph/u);
});

test("public repository exposes qdrant reconciliation smoke as a read-only full-stack check", async () => {
  const files = [
    "app/qdrant-sync/consistency-reconcile.ts",
    "app/qdrant-sync/replay-repair.ts",
    "app/ops/outbox-recovery.ts",
    "scripts/qdrant-reconcile.ts",
    "scripts/outbox-recovery.ts",
    "scripts/qdrant-collection-audit.ts",
    "scripts/qdrant-alias.ts",
    "scripts/qdrant-reconciliation-smoke.ts",
    "tests/qdrant-reconciliation-smoke.test.ts",
  ];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2/u.test(content)) stale.push(file);
    } catch {
      missing.push(file);
    }
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const capabilities = await readFile("app/full-stack-capabilities.ts", "utf8");
  const smoke = await readFile("scripts/qdrant-reconciliation-smoke.ts", "utf8");
  const readme = await readFile("README.md", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const operationsZh = await readFile("docs/operations.zh-CN.md", "utf8");
  const moduleCatalog = await readFile("docs/module-catalog.md", "utf8");

  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
  assert.equal(packageJson.scripts["smoke:qdrant-reconciliation"], "node --import tsx scripts/qdrant-reconciliation-smoke.ts");
  assert.match(packageJson.scripts["verify:open-source"], /tests\/qdrant-reconciliation-smoke\.test\.ts/u);
  assert.match(capabilities, /name: "qdrant_reconciliation"[\s\S]*scripts\/qdrant-reconciliation-smoke\.ts/u);
  assert.doesNotMatch(smoke, /--apply|--mark-dispatched|fix-qdrant-replay\.ts|replay-qdrant-outbox\.ts/u);
  assert.match(readme, /TMPDIR=\/tmp npm run smoke:qdrant-reconciliation/u);
  assert.match(operations, /TMPDIR=\/tmp npm run smoke:qdrant-reconciliation/u);
  assert.match(operationsZh, /TMPDIR=\/tmp npm run smoke:qdrant-reconciliation/u);
  assert.match(moduleCatalog, /smoke:qdrant-reconciliation/u);
});

test("public repository exposes recall quality smoke as a read-only full-stack check", async () => {
  const files = [
    "app/recall/orchestrator.ts",
    "app/recall/reranker.ts",
    "scripts/memory-quality.ts",
    "scripts/intelligence-quality.ts",
    "scripts/benchmark-reranker-policy.ts",
    "scripts/trace-replay-feedback.ts",
    "scripts/recall-quality-smoke.ts",
    "tests/recall-quality-smoke.test.ts",
  ];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2/u.test(content)) stale.push(file);
    } catch {
      missing.push(file);
    }
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const capabilities = await readFile("app/full-stack-capabilities.ts", "utf8");
  const smoke = await readFile("scripts/recall-quality-smoke.ts", "utf8");
  const readme = await readFile("README.md", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const operationsZh = await readFile("docs/operations.zh-CN.md", "utf8");
  const moduleCatalog = await readFile("docs/module-catalog.md", "utf8");

  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
  assert.equal(packageJson.scripts["smoke:recall-quality"], "node --import tsx scripts/recall-quality-smoke.ts");
  assert.match(packageJson.scripts["verify:open-source"], /tests\/recall-quality-smoke\.test\.ts/u);
  assert.match(capabilities, /name: "recall_quality"[\s\S]*scripts\/recall-quality-smoke\.ts/u);
  assert.doesNotMatch(smoke, /--apply|--write-observations|memory-recall-repair\.ts|memory-local-agent-evidence\.ts/u);
  assert.match(readme, /TMPDIR=\/tmp npm run smoke:recall-quality/u);
  assert.match(operations, /TMPDIR=\/tmp npm run smoke:recall-quality/u);
  assert.match(operationsZh, /TMPDIR=\/tmp npm run smoke:recall-quality/u);
  assert.match(moduleCatalog, /smoke:recall-quality/u);
});

test("public repository exposes temporal ops smoke for decay and consolidation dry-runs", async () => {
  const files = [
    "app/decay/index.ts",
    "app/decay/calculator.ts",
    "app/decay/production-decay.ts",
    "app/consolidation/index.ts",
    "app/consolidation/worker.ts",
    "app/consolidation/merge-engine.ts",
    "scripts/decay-run.ts",
    "scripts/temporal-sweep.ts",
    "scripts/memory-temporal-policy.ts",
    "scripts/memory-consolidate.ts",
    "scripts/temporal-ops-smoke.ts",
    "tests/temporal-ops-smoke.test.ts",
  ];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2/u.test(content)) stale.push(file);
    } catch {
      missing.push(file);
    }
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const capabilities = await readFile("app/full-stack-capabilities.ts", "utf8");
  const smoke = await readFile("scripts/temporal-ops-smoke.ts", "utf8");
  const readme = await readFile("README.md", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const operationsZh = await readFile("docs/operations.zh-CN.md", "utf8");
  const moduleCatalog = await readFile("docs/module-catalog.md", "utf8");

  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
  assert.equal(packageJson.scripts["smoke:temporal-ops"], "node --import tsx scripts/temporal-ops-smoke.ts");
  assert.match(packageJson.scripts["verify:open-source"], /tests\/temporal-ops-smoke\.test\.ts/u);
  assert.match(capabilities, /name: "temporal_decay"[\s\S]*scripts\/temporal-ops-smoke\.ts/u);
  assert.match(capabilities, /name: "temporal_consolidation"[\s\S]*scripts\/temporal-ops-smoke\.ts/u);
  assert.doesNotMatch(smoke, /--apply|memory-consolidate\.ts",\s*"--apply"|memory-temporal-policy\.ts",\s*"apply"/u);
  assert.match(readme, /TMPDIR=\/tmp npm run smoke:temporal-ops/u);
  assert.match(operations, /TMPDIR=\/tmp npm run smoke:temporal-ops/u);
  assert.match(operationsZh, /TMPDIR=\/tmp npm run smoke:temporal-ops/u);
  assert.match(moduleCatalog, /smoke:temporal-ops/u);
});

test("public repository exposes backup ops smoke for dry-run backup and deployment packaging", async () => {
  const files = [
    "app/ops/preflight.ts",
    "app/ops/rollback.ts",
    "app/runtime-config-validator.ts",
    "scripts/memory-backup.ts",
    "scripts/memory-migration-preflight.ts",
    "scripts/memory-deployment-bundle.ts",
    "scripts/memory-secrets-audit.ts",
    "scripts/backup-ops-smoke.ts",
    "tests/backup-ops-smoke.test.ts",
  ];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2/u.test(content)) stale.push(file);
    } catch {
      missing.push(file);
    }
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const capabilities = await readFile("app/full-stack-capabilities.ts", "utf8");
  const smoke = await readFile("scripts/backup-ops-smoke.ts", "utf8");
  const readme = await readFile("README.md", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const operationsZh = await readFile("docs/operations.zh-CN.md", "utf8");
  const moduleCatalog = await readFile("docs/module-catalog.md", "utf8");

  assert.deepEqual(missing, []);
  assert.deepEqual(stale, []);
  assert.equal(packageJson.scripts["smoke:backup-ops"], "node --import tsx scripts/backup-ops-smoke.ts");
  assert.match(packageJson.scripts["verify:open-source"], /tests\/backup-ops-smoke\.test\.ts/u);
  assert.match(capabilities, /name: "backup_and_restore"[\s\S]*scripts\/backup-ops-smoke\.ts/u);
  assert.match(capabilities, /name: "deployment_packaging"[\s\S]*scripts\/backup-ops-smoke\.ts/u);
  assert.doesNotMatch(smoke, /--apply|pg_dump|copyFileSync|chmodSync|memory-governance-revert|rollback/u);
  assert.match(readme, /TMPDIR=\/tmp npm run smoke:backup-ops/u);
  assert.match(operations, /TMPDIR=\/tmp npm run smoke:backup-ops/u);
  assert.match(operationsZh, /TMPDIR=\/tmp npm run smoke:backup-ops/u);
  assert.match(moduleCatalog, /smoke:backup-ops/u);
});

test("public sidecar sources use memory-xx names and avoid runtime artifacts", async () => {
  const files = [
    "sidecars/embedding-proxy/embedding-proxy.mjs",
    "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs",
    "sidecars/reranker-adapter/reranker-adapter.mjs",
    "sidecars/mem0-extractor/extractor.py",
    "sidecars/fastpath/fastpath.mjs",
    "sidecars/lexical-sidecar/lexical-sidecar.mjs",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/MEMORY_V2_|memory-v2|Memory-v2|\/api\/memory\/v2/u.test(content)) stale.push(file);
  }

  assert.deepEqual(stale, []);

  const fs = await import("node:fs/promises");
  await assert.rejects(() => fs.stat("sidecars/embedding-proxy/embedding-proxy.log"), /ENOENT/u);
  await assert.rejects(() => fs.stat("sidecars/mem0-extractor/__pycache__"), /ENOENT/u);
});

test("compose host bind env vars are honored by sidecar sources", async () => {
  const bindings = [
    ["MEMORY_XX_EMBEDDING_PROXY_HOST", "sidecars/embedding-proxy/embedding-proxy.mjs"],
    ["MEMORY_XX_QDRANT_PROXY_HOST", "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs"],
    ["MEMORY_XX_RERANKER_ADAPTER_HOST", "sidecars/reranker-adapter/reranker-adapter.mjs"],
    ["MEMORY_XX_MEM0_EXTRACTOR_HOST", "sidecars/mem0-extractor/extractor.py"],
  ] as const;
  const missing: string[] = [];
  for (const [envName, source] of bindings) {
    const content = await readFile(source, "utf8");
    if (!content.includes(envName)) missing.push(`${source}:${envName}`);
  }

  assert.deepEqual(missing, []);
});

test("public systemd sidecar units point at repo-local sidecar sources", async () => {
  const units = [
    "systemd/memory-xx-embedding-proxy.service",
    "systemd/memory-xx-qdrant-proxy.service",
    "systemd/memory-xx-reranker-adapter.service",
    "systemd/memory-xx-mem0-extractor.service",
    "systemd/memory-xx-fastpath.service",
    "systemd/memory-xx-lexical-sidecar.service",
  ];
  const stale: string[] = [];
  for (const unit of units) {
    const content = await readFile(unit, "utf8");
    if (
      !/sidecars\//u.test(content) ||
      /services\/memory-xx-(embedding-proxy|qdrant-proxy|reranker-adapter|mem0-extractor|fastpath|lexical-sidecar)/u.test(content) ||
      /\/mnt\/|[A-Z]:\\/u.test(content)
    ) {
      stale.push(unit);
    }
  }

  assert.deepEqual(stale, []);
});

test("public systemd worker and control units point at repo-local source scripts", async () => {
  const units = [
    ["systemd/memory-xx-conversation-monitor-worker.service", "scripts/run-conversation-monitor-worker.ts"],
    ["systemd/memory-xx-markdown-projection.service", "scripts/run-markdown-projection-worker.ts"],
    ["systemd/memory-xx-dream-worker.service", "scripts/run-dream-worker.ts"],
    ["systemd/memory-xx-control-panel.service", "scripts/memory-control-panel.ts"],
    ["systemd/memory-xx-cache-invalidation-worker.service", "scripts/run-cache-invalidation-worker.ts"],
    ["systemd/memory-xx-write-ticket-worker.service", "scripts/run-write-ticket-worker.ts"],
  ] as const;
  const stale: string[] = [];
  for (const [unit, source] of units) {
    const content = await readFile(unit, "utf8");
    if (
      !content.includes(source) ||
      /services\/memory-xx-(conversation-monitor|control-panel)/u.test(content) ||
      /\/mnt\/|[A-Z]:\\/u.test(content)
    ) {
      stale.push(unit);
    }
  }

  assert.deepEqual(stale, []);
  assert.match(await readFile("systemd/memory-xx-cache-invalidation-worker.service", "utf8"), /MEMORY_XX_CACHE_INVALIDATION_STATUS_FILE=%h\/services\/memory-xx\/\.runtime\/cache-invalidation-worker\.status\.json/u);
  assert.match(await readFile("systemd/memory-xx-write-ticket-worker.service", "utf8"), /MEMORY_XX_WRITE_TICKET_WORKER_STATUS_FILE=%h\/services\/memory-xx\/\.runtime\/write-ticket-worker\.status\.json/u);
  assert.match(await readFile("systemd/memory-xx-dream-worker.service", "utf8"), /MEMORY_XX_DREAM_STATUS_FILE=%h\/services\/memory-xx\/\.runtime\/dream-worker\.status\.json/u);
  assert.match(await readFile("systemd/memory-xx-markdown-projection.service", "utf8"), /MEMORY_XX_MARKDOWN_PROJECTION_STATUS_FILE=%h\/services\/memory-xx\/\.runtime\/markdown-projection\.status\.json/u);
});

test("public systemd default target starts only core services", async () => {
  const target = await readFile("systemd/memory-xx.target", "utf8");

  for (const coreService of [
    "memory-xx-wrapper.service",
    "memory-xx-qdrant-projector-worker.service",
    "memory-xx-embedding-proxy.service",
  ]) {
    assert.match(target, new RegExp(`^Wants=${coreService.replaceAll(".", "\\.")}$`, "mu"));
  }

  for (const pluggableService of [
    "memory-xx-embedding-upstream.service",
    "memory-xx-fastpath.service",
    "memory-xx-lexical-sidecar.service",
    "memory-xx-reranker-adapter.service",
    "memory-xx-reranker-upstream.service",
    "memory-xx-qdrant-proxy.service",
    "memory-xx-mem0-extractor.service",
    "memory-xx-conversation-monitor-worker.service",
    "memory-xx-cache-invalidation-worker.service",
    "memory-xx-write-ticket-worker.service",
    "memory-xx-control-panel.service",
  ]) {
    assert.doesNotMatch(target, new RegExp(`^Wants=${pluggableService.replaceAll(".", "\\.")}$`, "mu"));
  }
});

test("public systemd profile targets expose enhanced and full pluggable service groups", async () => {
  const enhancedTarget = await readFile("systemd/memory-xx-enhanced.target", "utf8");
  const fullTarget = await readFile("systemd/memory-xx-full.target", "utf8");

  assert.match(enhancedTarget, /^Wants=memory-xx\.target$/mu);
  for (const service of [
    "memory-xx-embedding-upstream.service",
    "memory-xx-qdrant-proxy.service",
    "memory-xx-fastpath.service",
    "memory-xx-lexical-sidecar.service",
    "memory-xx-reranker-upstream.service",
    "memory-xx-reranker-adapter.service",
    "memory-xx-mem0-extractor.service",
    "memory-xx-conversation-monitor-worker.service",
    "memory-xx-control-panel.service",
  ]) {
    assert.match(enhancedTarget, new RegExp(`^Wants=${service.replaceAll(".", "\\.")}$`, "mu"));
  }

  assert.match(fullTarget, /^Wants=memory-xx-enhanced\.target$/mu);
  for (const service of [
    "memory-xx-markdown-projection.service",
    "memory-xx-dream-worker.service",
    "memory-xx-cache-invalidation-worker.service",
    "memory-xx-write-ticket-worker.service",
    "memory-xx-maintenance.service",
    "memory-xx-consolidation.service",
    "memory-xx-detect.service",
    "memory-xx-auto-repair.service",
    "memory-xx-repair-report.service",
    "memory-xx-landing-scan.service",
    "memory-xx-canary-7d-report.service",
    "memory-xx-quality-runner.service",
    "memory-xx-governance-report.service",
  ]) {
    assert.match(fullTarget, new RegExp(`^Wants=${service.replaceAll(".", "\\.")}$`, "mu"));
  }
});

test("current public runtime services do not use experimental next suffixes", async () => {
  const files = [
    "app/runtime-modules.ts",
    "scripts/control-panel/service-controls.ts",
    "scripts/control-panel/runtime-snapshot.ts",
    "scripts/control-panel/summary.ts",
    "scripts/memory-doctor.ts",
    "systemd/memory-xx.target",
    "systemd/memory-xx-enhanced.target",
    "systemd/memory-xx-full.target",
    "docs/module-catalog.md",
    "docs/runtime-profiles.md",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/memory-xx-(embedding-proxy|qdrant-proxy|reranker-adapter)-next\.service/u.test(content)) {
      stale.push(file);
    }
  }

  assert.deepEqual(stale, []);
});

test("public systemd pluggable units honor runtime module kill switches", async () => {
  const missing: string[] = [];
  for (const module of RUNTIME_MODULES) {
    if (!module.startable || !module.service || !module.env_enabled) continue;
    const unit = `systemd/${module.service}`;
    const content = await readFile(unit, "utf8");
    const expected = `ExecCondition=/usr/bin/node --import tsx scripts/runtime-module-enabled.ts ${module.name}`;
    if (!content.includes(expected)) missing.push(`${module.name}:${module.service}`);
  }

  assert.deepEqual(missing, []);
});

test("public systemd gate units are directly installable without project-root placeholders", async () => {
  const units = [
    "systemd/memory-xx-landing-scan.service",
    "systemd/memory-xx-canary-7d-report.service",
    "systemd/memory-xx-quality-runner.service",
    "systemd/memory-xx-governance-report.service",
  ];
  const stale: string[] = [];
  for (const unit of units) {
    const content = await readFile(unit, "utf8");
    if (
      /<project-root>/u.test(content) ||
      !/WorkingDirectory=%h\/services\/memory-xx/u.test(content) ||
      !/EnvironmentFile=%h\/services\/memory-xx\/\.env/u.test(content) ||
      !/MEMORY_XX_RUNTIME_DIR=%h\/services\/memory-xx\/\.runtime/u.test(content)
    ) {
      stale.push(unit);
    }
  }

  assert.deepEqual(stale, []);
});

async function waitForSidecar(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`sidecar exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until the process binds the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`sidecar did not become ready at ${baseUrl}`);
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (!address || typeof address === "string") throw new Error("failed to allocate free port");
  return address.port;
}

async function waitForSidecarResponse(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`sidecar exited early with code ${child.exitCode}`);
    }
    try {
      await fetch(`${baseUrl}/health`);
      return;
    } catch {
      // Retry until the process binds the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`sidecar did not respond at ${baseUrl}`);
}

async function stopSidecar(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("fastpath sidecar starts from source and degrades safely without databases", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["sidecars/fastpath/fastpath.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      MEMORY_XX_FASTPATH_ADDR: `127.0.0.1:${port}`,
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_REDIS_URL: "",
      MEMORY_XX_QDRANT_BASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForSidecarResponse(baseUrl, child);

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as {
      ok?: boolean;
      status?: string;
    };
    assert.equal(health.ok, true);
    assert.equal(health.status, "degraded");

    const recall = await fetch(`${baseUrl}/recall-fast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "missing database still returns safely", scopeType: "user", scopeId: "u1", topK: 3 }),
    }).then((response) => response.json()) as {
      ok?: boolean;
      candidates?: unknown[];
      degraded?: boolean;
    };

    assert.equal(recall.ok, true);
    assert.equal(recall.degraded, true);
    assert.deepEqual(recall.candidates, []);
  } finally {
    await stopSidecar(child);
  }
});

test("lexical sidecar starts from source and degrades safely without Postgres", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["sidecars/lexical-sidecar/lexical-sidecar.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      MEMORY_XX_LEXICAL_ADDR: `127.0.0.1:${port}`,
      MEMORY_XX_DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForSidecarResponse(baseUrl, child);

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as {
      ok?: boolean;
      status?: string;
    };
    assert.equal(health.ok, true);
    assert.equal(health.status, "degraded");

    const search = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "missing database", scopeType: "user", scopeId: "u1", limit: 3 }),
    }).then((response) => response.json()) as {
      ok?: boolean;
      candidates?: unknown[];
      degraded?: boolean;
    };

    assert.equal(search.ok, true);
    assert.equal(search.degraded, true);
    assert.deepEqual(search.candidates, []);
  } finally {
    await stopSidecar(child);
  }
});

test("embedding proxy starts from source and reports missing upstream clearly", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["sidecars/embedding-proxy/embedding-proxy.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      MEMORY_XX_EMBEDDING_PROXY_HOST: "127.0.0.1",
      MEMORY_XX_EMBEDDING_PROXY_PORT: String(port),
      MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_BASE: "",
      EMBEDDING_API_BASE: "",
      OPENAI_API_KEY: "",
      EMBEDDING_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForSidecarResponse(baseUrl, child);

    const healthResponse = await fetch(`${baseUrl}/health`);
    const health = await healthResponse.json() as {
      ok?: boolean;
      upstream_configured?: boolean;
    };
    assert.equal(healthResponse.status, 503);
    assert.equal(health.ok, false);
    assert.equal(health.upstream_configured, false);

    const embeddings = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "missing upstream", model: "public-test" }),
    }).then((response) => response.json()) as {
      error?: string;
    };

    assert.equal(embeddings.error, "embedding_proxy_not_configured");
  } finally {
    await stopSidecar(child);
  }
});

test("qdrant proxy starts from source and reports upstream failures without exiting", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["sidecars/qdrant-proxy/qdrant-collection-proxy.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      MEMORY_XX_QDRANT_PROXY_HOST: "127.0.0.1",
      MEMORY_XX_QDRANT_PROXY_PORT: String(port),
      MEMORY_XX_QDRANT_PROXY_UPSTREAM: "http://127.0.0.1:9",
      MEMORY_XX_QDRANT_PROXY_TIMEOUT_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForSidecarResponse(baseUrl, child);

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as {
      ok?: boolean;
      upstream?: string;
    };
    assert.equal(health.ok, true);
    assert.equal(health.upstream, "http://127.0.0.1:9");

    const scroll = await fetch(`${baseUrl}/collections/memory-xx/points/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });
    const payload = await scroll.json() as { error?: string };

    assert.equal(scroll.status, 502);
    assert.equal(payload.error, "qdrant_proxy_failed");
    assert.equal(child.exitCode, null);
  } finally {
    await stopSidecar(child);
  }
});

test("reranker adapter starts from source and reports missing model upstream", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["sidecars/reranker-adapter/reranker-adapter.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      MEMORY_XX_RERANKER_ADAPTER_HOST: "127.0.0.1",
      MEMORY_XX_RERANKER_ADAPTER_PORT: String(port),
      MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL: "http://127.0.0.1:9/v3/models",
      MEMORY_XX_RERANKER_DOWNSTREAM_URL: "http://127.0.0.1:9/v3/rerank",
      MEMORY_XX_RERANKER_ADAPTER_TIMEOUT_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForSidecarResponse(baseUrl, child);

    const health = await fetch(`${baseUrl}/health`);
    const healthPayload = await health.json() as {
      ok?: boolean;
      downstream_ok?: boolean;
    };
    assert.equal(health.status, 503);
    assert.equal(healthPayload.ok, false);
    assert.equal(healthPayload.downstream_ok, false);

    const rerank = await fetch(`${baseUrl}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "q", documents: ["a", "b"] }),
    });
    const payload = await rerank.json() as { error?: string };

    assert.equal(rerank.status, 502);
    assert.equal(payload.error, "downstream_rerank_failed");
    assert.equal(child.exitCode, null);
  } finally {
    await stopSidecar(child);
  }
});

test("mem0 extractor starts from source and falls back when LLM endpoint is absent", async () => {
  const port = await getFreePort();
  const child = spawn("python3", ["sidecars/mem0-extractor/extractor.py"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      MEMORY_XX_MEM0_EXTRACTOR_HOST: "127.0.0.1",
      MEMORY_XX_MEM0_EXTRACTOR_PORT: String(port),
      MEMORY_XX_MEM0_BASE_URL: "",
      MEMORY_XX_MEM0_ENDPOINT: "",
      MEMORY_XX_MEM0_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForSidecar(baseUrl, child);

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as {
      ok?: boolean;
      endpoint_configured?: boolean;
    };
    assert.equal(health.ok, true);
    assert.equal(health.endpoint_configured, false);

    const extraction = await fetch(`${baseUrl}/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "请记住：memory-xx 开源版必须支持模块热插拔。" }),
    }).then((response) => response.json()) as {
      ok?: boolean;
      mem0_fallback_reason?: string;
      fallback_used?: boolean;
      memories?: unknown[];
    };

    assert.equal(extraction.ok, true);
    assert.ok(Array.isArray(extraction.memories));
    assert.ok(extraction.memories.length > 0);
  } finally {
    await stopSidecar(child);
  }
});

test("public docs expose runtime module state semantics", async () => {
  const api = await readFile("docs/api.md", "utf8");
  const runtimeProfiles = await readFile("docs/runtime-profiles.md", "utf8");

  assert.match(api, /"runtime_modules"/u);
  assert.match(api, /"full_stack_capabilities"/u);
  assert.match(api, /"missing_dependency"/u);
  assert.match(api, /"dependencies": \["fastpath", "lexical_sidecar", "reranker_adapter"\]/u);
  assert.match(api, /"reason": "dependency_unavailable:fastpath:disabled"/u);
  assert.match(api, /"maintenance_orchestrator"/u);
  assert.match(api, /"auto_repair"/u);
  assert.match(api, /"canary_7d_report"/u);
  assert.match(runtimeProfiles, /runtime_modules\.states/u);
  assert.match(runtimeProfiles, /full_stack_capabilities\.states/u);
  assert.match(runtimeProfiles, /dependencies, state, reason, and\s+degraded behavior/u);
  assert.match(runtimeProfiles, /enabled.*disabled.*degraded.*missing_dependency/us);
});

test("public docs explain wrapper activation switches for optional sidecars", async () => {
  const runtimeProfiles = await readFile("docs/runtime-profiles.md", "utf8");
  const vectorRuntime = await readFile("docs/vector-runtime.zh-CN.md", "utf8");

  for (const content of [runtimeProfiles, vectorRuntime]) {
    assert.match(content, /MEMORY_XX_RECALL_PRIMARY=fastpath/u);
    assert.match(content, /MEMORY_XX_RERANKER_MODE=model/u);
    assert.match(content, /MEMORY_XX_RERANKER_ENDPOINT/u);
    assert.match(content, /MEMORY_INTELLIGENCE_PROVIDER=mem0/u);
    assert.match(content, /MEMORY_INTELLIGENCE_MEM0_URL/u);
  }
});

test("public runtime profile smoke is exposed as an offline open-source verification entrypoint", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const readme = await readFile("README.md", "utf8");
  const runtimeProfiles = await readFile("docs/runtime-profiles.md", "utf8");
  const script = await readFile("scripts/runtime-profile-smoke.ts", "utf8");

  assert.equal(packageJson.scripts["smoke:runtime-profiles"], "node --import tsx scripts/runtime-profile-smoke.ts");
  assert.match(readme, /npm run smoke:runtime-profiles/u);
  assert.match(readme, /smoke:runtime-profiles -- --live --url/u);
  assert.match(runtimeProfiles, /npm run smoke:runtime-profiles/u);
  assert.match(runtimeProfiles, /smoke:runtime-profiles -- --live --url/u);
  assert.match(script, /buildRuntimeModuleSnapshot/u);
  assert.match(script, /buildRuntimeProfileLiveSmokeReport/u);
  assert.match(script, /FULL_STACK_CAPABILITIES/u);
});

test("public functional smoke script is portable and auth-aware", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const readme = await readFile("README.md", "utf8");
  const quickstart = await readFile("docs/quickstart.zh-CN.md", "utf8");
  const script = await readFile("scripts/functional-test-memory-xx.sh", "utf8");

  assert.equal(packageJson.scripts["smoke:functional"], "bash scripts/functional-test-memory-xx.sh");
  assert.match(readme, /npm run smoke:functional/u);
  assert.match(quickstart, /npm run smoke:functional/u);
  assert.doesNotMatch(script, /shadow_r3_\d+/u);
  assert.doesNotMatch(script, /<linux-user-home>/u);
  assert.match(script, /MEMORY_XX_DATABASE_SCHEMA:-memory_xx/u);
  assert.match(script, /LOG_DIR="\$\{LOG_DIR:-\$\(pwd\)\/\.runtime\/functional-tests\}"/u);
  assert.match(script, /MEMORY_XX_API_TOKEN/u);
  assert.match(script, /Authorization: Bearer/u);
  assert.doesNotMatch(script, /test_m4\s*\n\s*test_m4/u);
});

test("public scripts do not document private shadow schemas", async () => {
  const files = await collectPublicFiles("scripts", [".ts", ".js", ".mjs", ".sh", ".ps1"]);
  const stale = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/shadow_r3_\d+/u.test(content)) stale.push(file);
  }

  assert.deepEqual(stale.sort(), []);
});

test("public Windows helper scripts derive paths from env or current directory", async () => {
  const files = await collectPublicFiles("scripts/windows", [".ps1"]);
  const staleDefaults = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/\[[^\]]+\]\$\w+\s*=\s*"<(?:project-root|windows-drive)>/u.test(content)) {
      staleDefaults.push(file);
    }
  }

  assert.deepEqual(staleDefaults.sort(), []);
  assert.match(await readFile("scripts/windows/start-memory-xx.ps1", "utf8"), /MEMORY_XX_WSL_PROJECT_ROOT/u);
  assert.match(await readFile("scripts/windows/status-memory-xx.ps1", "utf8"), /MEMORY_XX_WSL_PROJECT_ROOT/u);
  assert.match(await readFile("scripts/windows/stop-memory-xx.ps1", "utf8"), /MEMORY_XX_WSL_PROJECT_ROOT/u);
  assert.match(await readFile("scripts/windows/start-ovms-upstreams.ps1", "utf8"), /MEMORY_XX_OVMS_DIR/u);
});

test("public OVMS helpers require explicit local paths instead of private defaults", async () => {
  const manager = await readFile("scripts/manage-ovms-upstream.sh", "utf8");
  const benchmark = await readFile("scripts/local-qwen8b-benchmark.ts", "utf8");
  const platformDoctor = await readFile("scripts/platform/platform-doctor.ts", "utf8");
  const windowsSystemPath = new RegExp("/" + "mnt" + "/" + "c" + "/" + "Windows", "u");
  const windowsOvmsDrivePath = new RegExp("D:" + "/" + "ovms", "u");
  const privateOvmsPath = new RegExp("/" + "mnt" + "/" + "d" + "/" + "ovms|api_key\\.txt", "u");

  assert.match(manager, /MEMORY_XX_OVMS_DIR is required/u);
  assert.ok(manager.includes("MEMORY_XX_EMBEDDING_UPSTREAM_API_KEY_FILE:-}"));
  assert.match(benchmark, /MEMORY_XX_EMBEDDING_UPSTREAM_API_KEY_FILE/u);
  assert.match(platformDoctor, /<memory-xx-ovms-dir>/u);
  assert.doesNotMatch(platformDoctor, /Windows 侧启动/u);
  assert.doesNotMatch(manager, windowsSystemPath);
  assert.doesNotMatch(platformDoctor, windowsSystemPath);
  assert.doesNotMatch(platformDoctor, windowsOvmsDrivePath);
  assert.doesNotMatch(manager, /<windows-drive>\\ovms\\run-(?:embedding|reranker)\.bat/u);
  assert.doesNotMatch(manager, /WorkingDirectory '<windows-drive>\\ovms'/u);

  for (const [name, content] of Object.entries({ manager, benchmark, platformDoctor })) {
    assert.doesNotMatch(content, privateOvmsPath, name);
  }
});

test("public embedding upstream manager remains opt-in for remote providers", async () => {
  const registry = await readFile("app/runtime-modules.ts", "utf8");
  const catalog = await readFile("docs/module-catalog.md", "utf8");
  const runtimeProfiles = await readFile("docs/runtime-profiles.md", "utf8");
  const envExample = await readFile("configs/memory-xx-wrapper.env.example", "utf8");

  assert.match(registry, /name:\s*"embedding_upstream"[\s\S]*?expected_in:\s*\[\]/u);
  assert.match(registry, /name:\s*"embedding_upstream"[\s\S]*?default_enabled:\s*false/u);
  assert.match(catalog, /\| `embedding_upstream` \| external \| optional \|/u);
  assert.doesNotMatch(catalog, /`embedding_upstream` \| external \| expected: core\/enhanced\/full/u);
  assert.match(runtimeProfiles, /manager is optional and disabled by default/u);
  assert.match(runtimeProfiles, /remote\s+embedding provider/u);
  assert.match(envExample, /^MEMORY_XX_EMBEDDING_UPSTREAM_ENABLED=0$/mu);
});

test("public docs describe local embedding upstreams as optional external providers", async () => {
  const files = [
    "README.md",
    "docs/runtime-profiles.md",
    "docs/vector-runtime.zh-CN.md",
    "configs/memory-xx-wrapper.env.example",
    "scripts/platform/platform-doctor.ts",
    "scripts/local-qwen8b-benchmark.ts",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/bundled local|Local OVMS|本地 OVMS/u.test(content)) stale.push(file);
  }

  assert.deepEqual(stale, []);
});

test("public embedding defaults are provider-neutral", async () => {
  const files = [
    "README.md",
    "docs/quickstart.zh-CN.md",
    "docs/vector-runtime.zh-CN.md",
    "configs/memory-xx-wrapper.env.example",
    "systemd/memory-xx-embedding-proxy.service",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/EMBEDDING_MODEL=Qwen3|MEMORY_XX_EMBEDDING_GENERATION_ID=local-qwen|MEMORY_XX_QUERY_EMBEDDING_CACHE_VERSION=.*local-qwen|MEMORY_XX_REDIS_PREFIX=.*local-qwen/u.test(content)) {
      stale.push(file);
    }
  }

  assert.deepEqual(stale, []);
  assert.match(await readFile("configs/memory-xx-wrapper.env.example", "utf8"), /^EMBEDDING_MODEL=memory-xx-dev-embedding$/mu);
  assert.match(await readFile("configs/memory-xx-wrapper.env.example", "utf8"), /^EMBEDDING_DIMS=4096$/mu);
  assert.match(await readFile("docs/vector-runtime.zh-CN.md", "utf8"), /MEMORY_XX_EMBEDDING_GENERATION_ID=memory-xx-default-v1/u);
  assert.doesNotMatch(await readFile("systemd/memory-xx-embedding-proxy.service", "utf8"), /qwen3-embedding/u);
});

test("public intelligence defaults are provider-neutral", async () => {
  const config = await readFile("app/intelligence/config.ts", "utf8");
  assert.doesNotMatch(config, /qwen3-8b/u);
  assert.match(config, /memory-xx-dev-chat/u);
});

test("public generic embedding scripts do not default to local Qwen generations", async () => {
  const files = [
    "app/server/embedding-provider.ts",
    "app/server/runtime.ts",
    "app/server/cli.ts",
    "app/qdrant-sync/daemon.ts",
    "app/knowledge/service.ts",
    "scripts/memory-auto-repair.ts",
    "scripts/memory-knowledge-md.ts",
    "scripts/benchmark-reranker-policy.ts",
    "scripts/qdrant-reconcile.ts",
    "scripts/replay-qdrant-outbox.ts",
    "scripts/generate-embeddings.ts",
    "scripts/generate-local-memory-embeddings.ts",
    "scripts/embedding-manifest.ts",
    "scripts/embedding-calibration.ts",
    "scripts/control-panel/summary.ts",
    "scripts/control-panel/runtime-snapshot.ts",
    "scripts/memory-doctor.ts",
    "scripts/test-vector-retriever.ts",
    "scripts/live-recall-smoke.ts",
    "scripts/random-recall-sample.ts",
    "app/knowledge/markdown-governance.ts",
    "app/intelligence/graph-extraction.ts",
    "scripts/import-knowledge-chroma-export.ts",
    "scripts/test-harness/layers/L18-graph-recall.ts",
    "docs/api.md",
    "docs/architecture.md",
    "docs/operations.md",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/QwenEmbeddingProviderWrapper|Qwen3-Embedding-8B|memory-xx-local-qwen8b-int4(?:-v1)?|local-qwen8b-int4-v1/u.test(content)) {
      stale.push(file);
    }
  }

  assert.deepEqual(stale, []);
});

test("public generic graph extraction does not hardcode local model providers", async () => {
  const graphExtraction = await readFile("app/intelligence/graph-extraction.ts", "utf8");

  assert.doesNotMatch(graphExtraction, /Qwen3|OVMS|local-qwen/u);
});

test("public doctor and control panel remediation stays provider-neutral", async () => {
  const files = [
    "scripts/memory-doctor.ts",
    "scripts/control-panel/summary.ts",
    "scripts/control-panel/runtime-snapshot.ts",
    "scripts/control-panel/service-controls.ts",
    "scripts/control-panel/renderers.ts",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/Windows GPU|<windows-drive>\\ovms\\run-(?:embedding|reranker)\.bat|本地 OVMS|本地 Qwen3|Qwen3 embedding|Qwen3 reranker|OVMS 就绪|OVMS 不可用/u.test(content)) {
      stale.push(file);
    }
  }

  assert.deepEqual(stale, []);
});

test("public platform tooling does not default to private WSL GPU profile", async () => {
  const files = [
    "scripts/memory-migration-preflight.ts",
    "scripts/memory-deployment-bundle.ts",
    "scripts/control-panel/routes.ts",
    "scripts/control-panel/renderers.ts",
  ];
  const stale: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/\?\?\s*["']wsl-windows-gpu["']|profile=wsl-windows-gpu/u.test(content)) {
      stale.push(file);
    }
  }

  assert.deepEqual(stale, []);
});

test("public module catalog documents every runtime module and full-stack capability", async () => {
  const catalog = await readFile("docs/module-catalog.md", "utf8");
  const missingRuntimeModules = RUNTIME_MODULES
    .map((module) => module.name)
    .filter((name) => !catalog.includes(`| \`${name}\``));
  const missingCapabilities = FULL_STACK_CAPABILITIES
    .map((capability) => capability.name)
    .filter((name) => !catalog.includes(`| \`${name}\``));

  assert.deepEqual(missingRuntimeModules, []);
  assert.deepEqual(missingCapabilities, []);
});

test("MCP test fixtures use the public wrapper port 5100", async () => {
  const content = await readFile("tests/mcp-server.test.ts", "utf8");

  assert.match(content, /localhost:5100/u);
  assert.doesNotMatch(content, /localhost:4001|127\.0\.0\.1:4001/u);
});

test("release audit npm scripts avoid the tsx CLI tmp socket path", async () => {
  const packageJson = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile("package.json", "utf8"))) as {
    scripts: Record<string, string>;
  };

  assert.match(packageJson.scripts["check:secrets"], /^node --import tsx /u);
  assert.match(packageJson.scripts["open-source:preaudit"], /^node --import tsx /u);
  assert.match(packageJson.scripts["open-source:export"], /^node --import tsx /u);
});

test("npm scripts run TypeScript through node import hooks instead of the tsx CLI", async () => {
  const packageJson = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile("package.json", "utf8"))) as {
    scripts: Record<string, string>;
  };
  const directTsxScripts = Object.entries(packageJson.scripts)
    .filter(([, command]) => {
      const normalized = command.replace(/(?:^|[;&|]\s*)(?:[A-Z_][A-Z0-9_]*=\S+\s+)*/gu, "$&");
      return /(?:^|[;&|]\s*)(?:[A-Z_][A-Z0-9_]*=\S+\s+)*tsx\s+/u.test(normalized);
    })
    .map(([name]) => name);

  assert.deepEqual(directTsxScripts, []);
});

test("public docs do not recommend npx tsx commands", async () => {
  const files = [
    "README.md",
    "docs/migration-rollback-playbook.md",
    "docs/operations.md",
    "docs/quickstart.zh-CN.md",
  ];
  const stale = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/\bnpx\s+tsx\b/u.test(content)) stale.push(file);
  }

  assert.deepEqual(stale, []);
});

test("operational scripts do not spawn the tsx CLI", async () => {
  const files = [
    "scripts/test-harness/reports/aggregator.ts",
    "scripts/memory-quality.ts",
    "scripts/test-conversation-worker.ts",
    "scripts/memory-landing-scan.ts",
    "scripts/memory-auto-approval.ts",
    "scripts/embedding-manifest.ts",
  ];
  const stale = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (
      /execFileSync\("npx",\s*\["tsx"/u.test(content) ||
      /execFileSync\("npx"/u.test(content) ||
      /runCommand\("npx",\s*\["tsx"/u.test(content) ||
      /runJsonCommand\(\["tsx"/u.test(content) ||
      /`npx\s+tsx\b/u.test(content)
    ) {
      stale.push(file);
    }
  }

  assert.deepEqual(stale, []);
});

test("package exposes a production audit script pinned to the official npm registry", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.scripts["audit:prod"], "npm audit --omit=dev --registry=https://registry.npmjs.org");
});

test("package exposes public harness entrypoints for unit contract and conversation monitor layers", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const readme = await readFile("README.md", "utf8");
  const operations = await readFile("docs/operations.md", "utf8");
  const operationsZh = await readFile("docs/operations.zh-CN.md", "utf8");

  assert.equal(packageJson.scripts["test:unit-contract"], "node --import tsx scripts/test-harness/layers/L1-unit-contract.ts");
  assert.equal(packageJson.scripts["test:conversation-monitor"], "node --import tsx scripts/test-harness/layers/L19-conversation-monitor.ts");
  assert.equal(packageJson.scripts["smoke:conversation-monitor"], "node --import tsx scripts/conversation-monitor-smoke.ts");
  assert.equal(packageJson.scripts["smoke:cache-invalidation"], "node --import tsx scripts/cache-invalidation-smoke.ts");
  assert.equal(packageJson.scripts["smoke:write-ticket"], "node --import tsx scripts/write-ticket-smoke.ts");
  assert.equal(packageJson.scripts["smoke:markdown-projection"], "node --import tsx scripts/markdown-projection-smoke.ts");
  assert.equal(packageJson.scripts["smoke:memory-dreaming"], "node --import tsx scripts/memory-dreaming-smoke.ts");
  assert.equal(packageJson.scripts["smoke:full-ops"], "node --import tsx scripts/full-ops-smoke.ts");
  assert.equal(packageJson.scripts["smoke:policy-ops"], "node --import tsx scripts/policy-ops-smoke.ts");
  assert.match(readme, /npm run test:unit-contract/u);
  assert.match(readme, /npm run smoke:cache-invalidation/u);
  assert.match(readme, /npm run smoke:write-ticket/u);
  assert.match(readme, /npm run smoke:markdown-projection/u);
  assert.match(readme, /npm run smoke:memory-dreaming/u);
  assert.match(readme, /npm run smoke:full-ops/u);
  assert.match(readme, /npm run smoke:policy-ops/u);
  assert.match(operations, /npm run test:conversation-monitor/u);
  assert.match(operations, /npm run smoke:cache-invalidation/u);
  assert.match(operations, /npm run smoke:write-ticket/u);
  assert.match(operations, /npm run smoke:markdown-projection/u);
  assert.match(operations, /npm run smoke:memory-dreaming/u);
  assert.match(operations, /npm run smoke:full-ops/u);
  assert.match(operations, /npm run smoke:policy-ops/u);
  assert.match(operationsZh, /npm run test:conversation-monitor/u);
  assert.match(operationsZh, /npm run smoke:cache-invalidation/u);
  assert.match(operationsZh, /npm run smoke:write-ticket/u);
  assert.match(operationsZh, /npm run smoke:markdown-projection/u);
  assert.match(operationsZh, /npm run smoke:memory-dreaming/u);
  assert.match(operationsZh, /npm run smoke:full-ops/u);
  assert.match(operationsZh, /npm run smoke:policy-ops/u);
});

test("package exposes an open-source verification script without runtime env gates", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts["verify:open-source"] ?? "";

  assert.match(command, /npm run check:secrets/u);
  assert.match(command, /npm run open-source:preaudit -- --fail-on-blockers/u);
  assert.match(command, /tests\/open-source-readiness\.test\.ts/u);
  assert.match(command, /tests\/open-source-release\.test\.ts/u);
  assert.match(command, /tests\/runtime-modules\.test\.ts/u);
  assert.match(command, /tests\/full-stack-capabilities\.test\.ts/u);
  assert.match(command, /npm run audit:prod/u);
  assert.doesNotMatch(command, /test:gates|test:all-gates/u);
});
