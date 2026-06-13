import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function write(root: string, file: string, content = ""): Promise<void> {
  const full = path.join(root, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

test("package exposes a memory-v2 parity audit script", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.scripts["memory:parity-audit"], "node --import tsx scripts/memory-parity-audit.ts");
});

test("memory parity audit treats private memory-v2 names as open-source memory-xx equivalents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-parity-audit-"));
  const sourceRoot = path.join(root, "memory-v2");
  const targetRoot = path.join(root, "memory-xx");

  await write(sourceRoot, "app/example.ts", "export const api = '/api/memory/v2';\n");
  await write(targetRoot, "app/example.ts", "export const api = '/api/memory/xx';\n");
  await write(sourceRoot, "scripts/klee-memory-v2-wrapper.ts", "export const service = 'klee-memory-v2-wrapper';\n");
  await write(targetRoot, "scripts/memory-xx-wrapper.ts", "export const service = 'memory-xx-wrapper';\n");
  await write(sourceRoot, "systemd/openclaw-qdrant-projector-worker.service", "Description=openclaw\n");
  await write(targetRoot, "systemd/memory-xx-qdrant-projector-worker.service", "Description=memory-xx\n");
  await write(sourceRoot, "app/ignored.ts.pre-bak-restore", "backup\n");
  await write(sourceRoot, "reports/runtime.json", "{}\n");
  await write(sourceRoot, "package.json", JSON.stringify({ scripts: { "test:layers": "node a.js" } }));
  await write(targetRoot, "package.json", JSON.stringify({ scripts: { "test:layers": "node a.js", "verify:open-source": "npm run x" } }));

  const result = spawnSync("node", [
    "--import",
    "tsx",
    "scripts/memory-parity-audit.ts",
    "--json",
    "--fail-on-missing",
    "--source-root",
    sourceRoot,
    "--target-root",
    targetRoot,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    ok: boolean;
    missing_count: number;
    package_scripts: { only_in_source: string[] };
  };
  assert.equal(report.ok, true);
  assert.equal(report.missing_count, 0);
  assert.deepEqual(report.package_scripts.only_in_source, []);
});

test("memory parity audit exits non-zero when normalized source files are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-parity-audit-missing-"));
  const sourceRoot = path.join(root, "memory-v2");
  const targetRoot = path.join(root, "memory-xx");

  await write(sourceRoot, "app/present.ts", "export const value = 1;\n");
  await write(sourceRoot, "tests/missing.test.ts", "test('missing', () => {});\n");
  await write(targetRoot, "app/present.ts", "export const value = 1;\n");
  await write(sourceRoot, "package.json", JSON.stringify({ scripts: {} }));
  await write(targetRoot, "package.json", JSON.stringify({ scripts: {} }));

  const result = spawnSync("node", [
    "--import",
    "tsx",
    "scripts/memory-parity-audit.ts",
    "--json",
    "--fail-on-missing",
    "--source-root",
    sourceRoot,
    "--target-root",
    targetRoot,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as {
    ok: boolean;
    missing: string[];
  };
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ["tests/missing.test.ts"]);
});

test("memory parity audit exits non-zero when source root is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-parity-audit-no-source-"));
  const missingSourceRoot = path.join(root, "missing-memory-v2");
  const targetRoot = path.join(root, "memory-xx");
  await write(targetRoot, "package.json", JSON.stringify({ scripts: {} }));

  const result = spawnSync("node", [
    "--import",
    "tsx",
    "scripts/memory-parity-audit.ts",
    "--json",
    "--fail-on-missing",
    "--source-root",
    missingSourceRoot,
    "--target-root",
    targetRoot,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as {
    ok: boolean;
    errors: string[];
  };
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [`source root does not exist: ${missingSourceRoot}`]);
});
