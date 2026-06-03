import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("markdown audit projection and source-mode public surfaces are retired", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["memory:source-mode"], undefined);
  assert.equal(pkg.scripts?.["shadow:projection"], undefined);

  assert.equal(existsSync(path.join(root, "app", "source-mode.ts")), false);
  assert.equal(existsSync(path.join(root, "app", "projection")), false);
  assert.equal(existsSync(path.join(root, "scripts", "source-mode.ts")), false);
  assert.equal(existsSync(path.join(root, "scripts", "measure-projection-latency.ts")), false);
  assert.equal(existsSync(path.join(root, "scripts", "run-projection-shadow-r3.ts")), false);
  assert.equal(existsSync(path.join(root, "memory_projection")), false);

  const httpServer = read("app/server/http-server.ts");
  assert.equal(httpServer.includes("markdown_role"), false);
  assert.equal(httpServer.includes("memory:source-mode"), false);

  const readme = read("README.md");
  assert.equal(readme.includes("shadow:projection"), false);
  assert.equal(readme.includes("run-projection-shadow-r3"), false);
});
