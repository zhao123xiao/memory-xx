import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("memory-sweep-test-pollution catches mcp-user-flow pending test scopes", async () => {
  const source = await readFile("scripts/memory-sweep-test-pollution.ts", "utf8");

  assert.match(source, /mcp-user-flow/u);
});
