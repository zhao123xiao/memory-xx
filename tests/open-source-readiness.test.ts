import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOpenSourcePreauditReport } from "../app/ops/open-source-release";

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
    "sidecars/fastpath/README.md",
    "sidecars/lexical-sidecar/README.md",
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

test("public sidecar sources use memory-xx names and avoid runtime artifacts", async () => {
  const files = [
    "sidecars/embedding-proxy/embedding-proxy.mjs",
    "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs",
    "sidecars/reranker-adapter/reranker-adapter.mjs",
    "sidecars/mem0-extractor/extractor.py",
    "sidecars/fastpath/README.md",
    "sidecars/lexical-sidecar/README.md",
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

test("public systemd sidecar units point at repo-local sidecar sources", async () => {
  const units = [
    "systemd/memory-xx-embedding-proxy-next.service",
    "systemd/memory-xx-qdrant-proxy-next.service",
    "systemd/memory-xx-reranker-adapter-next.service",
    "systemd/memory-xx-mem0-extractor.service",
  ];
  const stale: string[] = [];
  for (const unit of units) {
    const content = await readFile(unit, "utf8");
    if (
      !/sidecars\//u.test(content) ||
      /services\/memory-xx-(embedding-proxy|qdrant-proxy|reranker-adapter|mem0-extractor)/u.test(content) ||
      /\/mnt\/|[A-Z]:\\/u.test(content)
    ) {
      stale.push(unit);
    }
  }

  assert.deepEqual(stale, []);
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
  assert.match(command, /npm run audit:prod/u);
  assert.doesNotMatch(command, /test:gates|test:all-gates/u);
});
