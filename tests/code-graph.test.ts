import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodeGraph, filterCodeGraph } from "../app/code-graph";

test("code graph extracts files, symbols, imports, and calls", () => {
  const root = path.join(tmpdir(), `memory-xx-code-graph-${Date.now()}`);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "util.ts"), "export function helper() { return 1; }\n");
  writeFileSync(path.join(root, "src", "main.ts"), [
    "import { helper } from './util';",
    "export class Runner { run() { return helper(); } }",
    "export function start() { return helper(); }",
  ].join("\n"));
  try {
    const graph = buildCodeGraph({ root });
    assert.equal(graph.summary.files, 2);
    assert.ok(graph.nodes.some((node) => node.id === "file:src/main.ts"));
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/util.ts#helper"));
    assert.ok(graph.edges.some((edge) =>
      edge.type === "imports" &&
      edge.source === "file:src/main.ts" &&
      edge.target === "file:src/util.ts"
    ));
    assert.ok(graph.edges.some((edge) =>
      edge.type === "calls" &&
      edge.source === "file:src/main.ts" &&
      edge.target === "symbol:src/util.ts#helper"
    ));

    const filtered = filterCodeGraph(graph, { query: "Runner", limit: 20 });
    assert.ok(filtered.nodes.some((node) => node.label === "Runner"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
