import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("knowledge ingest-directory script delegates to the markdown knowledge ingest pipeline", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/knowledge/ingest-directory.ts"), "utf8");

  assert.match(source, /scripts\/memory-knowledge-md\.ts/u);
  assert.match(source, /\bingest\b/u);
  assert.match(source, /--root=\$\{dir\}/u);
  assert.match(source, /--apply/u);
  assert.match(source, /--json/u);
  assert.match(source, /--scope-id/u);
  assert.match(source, /`--scope-id=\$\{scopeId\}`/u);
});

test("memory knowledge markdown CLI defaults to HOME rather than a user-specific root", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/memory-knowledge-md.ts"), "utf8");

  assert.match(source, /os\.homedir\(\)/u);
  assert.doesNotMatch(source, /argValue\("--root"\) \?\? "\/home\/xiaoxiao"/u);
});
