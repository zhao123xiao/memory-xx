import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildKnowledgeGraphSmokeReport } from "../scripts/knowledge-graph-smoke";

test("knowledge graph smoke reports missing live graph configuration", async () => {
  const report = await buildKnowledgeGraphSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_DATABASE_URL"]);
});

test("knowledge graph smoke validates knowledge ingest, memory graph, and code graph reportability", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-knowledge-graph-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "knowledge-scan.json"), JSON.stringify({
      ok: true,
      command: "scan",
      candidates: [
        { path: "README.md", kind: "markdown", bytes: 1200 },
      ],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "graph-health.json"), JSON.stringify({
      ok: false,
      status: "degraded",
      blockers: ["graph_entity_density_low"],
      warnings: ["graph tables are present but sparse"],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "memory-graph-report.json"), JSON.stringify({
      ok: true,
      out_dir: path.join(runtimeDir, "graph-report"),
      files: ["graph-report.json", "graph-report.html"],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "code-graph.json"), JSON.stringify({
      snapshot_id: "code_graph:memory-xx:test",
      summary: {
        files: 8,
        nodes: 24,
        edges: 31,
      },
    }), "utf8");

    const report = await buildKnowledgeGraphSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
      },
      runtimeDir,
      runCommand: async (_name, _args, outputFile) => outputFile,
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, [
      "knowledge_ingest",
      "memory_knowledge_graph",
      "code_graph",
    ]);
    assert.equal(report.results.knowledge_ingest?.ok, true);
    assert.equal(report.results.memory_knowledge_graph?.ok, false);
    assert.equal(report.results.memory_knowledge_graph?.degraded, true);
    assert.equal(report.results.code_graph?.ok, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
