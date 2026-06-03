import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodeGraph } from "../app/code-graph";

function makeProject(name: string): string {
  const root = path.join(tmpdir(), `memory-xx-${name}-${Date.now()}`);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "main.ts"), `export function ${name.replace(/\W/gu, "_")}() { return "${name}"; }\n`);
  return root;
}

test("code graph snapshots are project-scoped and do not share memory scope", () => {
  const alpha = makeProject("alpha-project");
  const beta = makeProject("beta-project");
  try {
    const graphA = buildCodeGraph({ root: alpha, projectId: "alpha" });
    const graphB = buildCodeGraph({ root: beta, projectId: "beta" });

    assert.equal(graphA.project_id, "alpha");
    assert.equal(graphB.project_id, "beta");
    assert.equal(graphA.summary.memory_scope_type, "project");
    assert.equal(graphA.summary.memory_scope_id, "alpha");
    assert.equal(graphB.summary.memory_scope_id, "beta");
    assert.notEqual(graphA.summary.code_graph_scope, graphB.summary.code_graph_scope);
    assert.match(graphA.snapshot_id, /^code_graph:alpha:/u);
    assert.match(graphB.snapshot_id, /^code_graph:beta:/u);
  } finally {
    rmSync(alpha, { recursive: true, force: true });
    rmSync(beta, { recursive: true, force: true });
  }
});
