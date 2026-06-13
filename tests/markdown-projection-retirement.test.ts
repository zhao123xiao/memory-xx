import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("markdown projection public surfaces are read-only pluggable exports", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["memory:source-mode"], "node --import tsx scripts/source-mode.ts");
  assert.equal(pkg.scripts?.["shadow:projection"], "node --import tsx scripts/run-projection-shadow-r3.ts");

  assert.equal(existsSync(path.join(root, "app", "source-mode.ts")), true);
  assert.equal(existsSync(path.join(root, "app", "projection")), true);
  assert.equal(existsSync(path.join(root, "scripts", "source-mode.ts")), true);
  assert.equal(existsSync(path.join(root, "scripts", "measure-projection-latency.ts")), false);
  assert.equal(existsSync(path.join(root, "scripts", "run-projection-shadow-r3.ts")), true);
  assert.equal(existsSync(path.join(root, "memory_projection")), false);

  const httpServer = read("app/server/http-server.ts");
  assert.equal(httpServer.includes("markdown_role"), false);
  assert.equal(httpServer.includes("memory:source-mode"), false);

  const sourceMode = read("app/source-mode.ts");
  assert.match(sourceMode, /source_of_truth: "postgres"/u);
  assert.match(sourceMode, /markdown_role: "review_projection"/u);
  assert.match(sourceMode, /reverse_sync_allowed: false/u);

  const readme = read("README.md");
  assert.match(readme, /Markdown projection/u);
  assert.match(readme, /不支持反向同步/u);
});
