import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("admin register-agent script delegates to the canonical memory-agent grant model", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/admin/register-agent.ts"), "utf8");

  assert.match(source, /scripts\/memory-agent\.ts/u);
  assert.match(source, /\bcreate\b/u);
  assert.match(source, /\bgrant\b/u);
  assert.match(source, /--scope=/u);
  assert.match(source, /--permissions=/u);
  assert.doesNotMatch(source, /trusted_agents\s*\([^)]*allowed_scopes/su);
  assert.doesNotMatch(source, /INSERT\s+INTO[\s\S]+trusted_agents[\s\S]+allowed_scopes/iu);
});
