import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

import { FULL_STACK_CAPABILITIES } from "../app/full-stack-capabilities";
import { buildOpenSourcePreauditReport } from "../app/ops/open-source-release";
import { RUNTIME_MODULES } from "../app/runtime-modules";

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
  assert.match(compose, /5100:5100/u);
  assert.doesNotMatch(compose, /4001:4001/u);
});

test("docker compose includes the core Qdrant projector worker", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");

  assert.match(compose, /^  memory-xx-qdrant-projector-worker:$/mu);
  assert.match(compose, /scripts\/run-qdrant-projector-worker\.ts/u);
  assert.match(compose, /MEMORY_XX_QDRANT_PROJECTOR_STATUS_FILE: \/app\/\.runtime\/qdrant-projector-worker\.status\.json/u);
  assert.match(compose, /memory-xx-embedding-proxy:\s*\n\s+condition: service_started/u);
  assert.match(compose, /qdrant:\s*\n\s+condition: service_started/u);
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
    "memory-xx-conversation-monitor",
    "memory-xx-cache-invalidation-worker",
    "memory-xx-control-panel",
  ]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "mu"), `missing compose service ${service}`);
  }

  assert.match(compose, /profiles:\s*\n\s+- enhanced/u);
  assert.match(compose, /profiles:\s*\n\s+- full/u);
  assert.match(compose, /sidecars\/fastpath\/fastpath\.mjs/u);
  assert.match(compose, /sidecars\/lexical-sidecar\/lexical-sidecar\.mjs/u);
  assert.match(compose, /scripts\/run-conversation-monitor-worker\.ts/u);
  assert.match(compose, /scripts\/runtime-module-enabled\.ts cache_invalidation_worker/u);
  assert.match(compose, /scripts\/memory-control-panel\.ts/u);
  assert.match(compose, /MEMORY_XX_RUNTIME_PROFILE: \$\{MEMORY_XX_RUNTIME_PROFILE:-core\}/u);
  assert.doesNotMatch(compose, /MEMORY_XX_FASTPATH_ENABLED: \$\{MEMORY_XX_FASTPATH_ENABLED:-true\}/u);
});

test("Dockerfile includes source needed by public pluggable modules", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");

  assert.match(dockerfile, /COPY sidecars\/ sidecars\//u);
  assert.match(dockerfile, /COPY scripts\/ scripts\//u);
  assert.match(dockerfile, /COPY app\/ app\//u);
  assert.match(dockerfile, /COPY tsconfig\.json \.\//u);
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

test("public docker profile docs set matching runtime profile", async () => {
  const files = ["docs/quickstart.zh-CN.md", "docs/operations.md"] as const;
  const missing: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (!/MEMORY_XX_RUNTIME_PROFILE=enhanced\s+docker-compose --profile enhanced up/u.test(content)) {
      missing.push(`${file}:enhanced`);
    }
    if (!/MEMORY_XX_RUNTIME_PROFILE=full\s+docker-compose --profile enhanced --profile full up/u.test(content)) {
      missing.push(`${file}:full`);
    }
  }

  assert.deepEqual(missing, []);
});

test("public systemd bundle provides the unit name used by scripts", async () => {
  const fs = await import("node:fs/promises");
  const wrapper = await fs.readFile("systemd/memory-xx-wrapper.service", "utf8");

  assert.match(wrapper, /^Description=OpenClaw memory-xx wrapper$/mu);
  assert.match(wrapper, /ExecStart=.*wrapper-entry\.mjs/u);
  await assert.rejects(
    () => fs.stat("systemd/openclaw-memory-xx-wrapper.service"),
    /ENOENT/u
  );
});

test("README documents required session roots and API embedding option", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /MEMORY_XX_CODEX_SESSION_ROOTS/u);
  assert.match(readme, /MEMORY_XX_CLAUDE_SESSION_ROOTS/u);
  assert.match(readme, /MEMORY_XX_OPENCLAW_SESSION_ROOTS/u);
  assert.match(readme, /https:\/\/www\.scnet\.cn/u);
  assert.match(readme, /0\.1\s*\/\s*百万\s*token/u);
  assert.match(readme, /MEMORY_XX_SCOPE_POLICY_MODE=single_user/u);
  assert.match(readme, /sidecar/u);
});

test("public repository includes source entries for pluggable full-stack sidecars", async () => {
  const files = [
    "sidecars/embedding-proxy/embedding-proxy.mjs",
    "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs",
    "sidecars/reranker-adapter/reranker-adapter.mjs",
    "sidecars/mem0-extractor/extractor.py",
    "sidecars/fastpath/fastpath.mjs",
    "sidecars/lexical-sidecar/lexical-sidecar.mjs",
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
    "tests/projection-foundation.test.ts",
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
  assert.match(runtimeModules, /name: "markdown_projection"/u);
  assert.match(runtimeModules, /MEMORY_XX_MARKDOWN_PROJECTION_ENABLED/u);
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
    "systemd/memory-xx-embedding-proxy-next.service",
    "systemd/memory-xx-qdrant-proxy-next.service",
    "systemd/memory-xx-reranker-adapter-next.service",
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
    ["systemd/memory-xx-control-panel.service", "scripts/memory-control-panel.ts"],
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
});

test("public systemd default target starts only core services", async () => {
  const target = await readFile("systemd/memory-xx.target", "utf8");

  for (const coreService of [
    "memory-xx-wrapper.service",
    "memory-xx-qdrant-projector-worker.service",
    "memory-xx-embedding-proxy-next.service",
  ]) {
    assert.match(target, new RegExp(`^Wants=${coreService.replaceAll(".", "\\.")}$`, "mu"));
  }

  for (const pluggableService of [
    "memory-xx-embedding-upstream.service",
    "memory-xx-fastpath.service",
    "memory-xx-lexical-sidecar.service",
    "memory-xx-reranker-adapter-next.service",
    "memory-xx-reranker-upstream.service",
    "memory-xx-qdrant-proxy-next.service",
    "memory-xx-mem0-extractor.service",
    "memory-xx-conversation-monitor-worker.service",
    "memory-xx-cache-invalidation-worker.service",
    "memory-xx-control-panel.service",
  ]) {
    assert.doesNotMatch(target, new RegExp(`^Wants=${pluggableService.replaceAll(".", "\\.")}$`, "mu"));
  }
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
  const port = 45200 + Math.floor(Math.random() * 1000);
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
    await waitForSidecar(baseUrl, child);

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
  const port = 46200 + Math.floor(Math.random() * 1000);
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
    await waitForSidecar(baseUrl, child);

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

test("public docs expose runtime module state semantics", async () => {
  const api = await readFile("docs/api.md", "utf8");
  const runtimeProfiles = await readFile("docs/runtime-profiles.md", "utf8");

  assert.match(api, /"runtime_modules"/u);
  assert.match(api, /"full_stack_capabilities"/u);
  assert.match(api, /"missing_dependency"/u);
  assert.match(api, /"maintenance_orchestrator"/u);
  assert.match(api, /"auto_repair"/u);
  assert.match(api, /"canary_7d_report"/u);
  assert.match(runtimeProfiles, /runtime_modules\.states/u);
  assert.match(runtimeProfiles, /full_stack_capabilities\.states/u);
  assert.match(runtimeProfiles, /enabled.*disabled.*degraded.*missing_dependency/us);
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

test("package exposes an open-source verification script without runtime env gates", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts["verify:open-source"] ?? "";

  assert.match(command, /npm run check:secrets/u);
  assert.match(command, /npm run open-source:preaudit/u);
  assert.match(command, /tests\/open-source-readiness\.test\.ts/u);
  assert.match(command, /tests\/open-source-release\.test\.ts/u);
  assert.match(command, /tests\/full-stack-capabilities\.test\.ts/u);
  assert.match(command, /npm run audit:prod/u);
  assert.doesNotMatch(command, /test:gates|test:all-gates/u);
});
