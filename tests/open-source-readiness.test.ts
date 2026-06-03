import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  assert.match(rootEnv, /^MEMORY_V2_WRAPPER_PORT=5100$/mu);
  assert.match(wrapperEnv, /^MEMORY_V2_WRAPPER_PORT=5100$/mu);
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
    .filter(([, command]) => /(^|&&\s*|\|\|\s*|;\s*)tsx\s+/u.test(command))
    .map(([name]) => name);

  assert.deepEqual(directTsxScripts, []);
});
