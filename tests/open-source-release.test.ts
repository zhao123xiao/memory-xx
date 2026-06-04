import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FULL_STACK_CAPABILITIES } from "../app/full-stack-capabilities";
import { buildOpenSourcePreauditReport, exportOpenSourceProject } from "../app/ops/open-source-release";
import { buildParityAuditReport } from "../scripts/open-source-parity-audit";

async function withTempDir<T>(callback: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-xx-export-"));
  try {
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

test("open source export preserves full-stack pluggable module sources, docs, and registry", async () => {
  await withTempDir(async (parent) => {
    const root = path.join(parent, "private-source");
    const targetDir = path.join(parent, "memory-xx");
    write(root, "package.json", JSON.stringify({
      name: "memory-xx",
      scripts: {
        "memory:source-mode": "node --import tsx scripts/source-mode.ts",
        "run:conversation-monitor-worker": "node --import tsx scripts/run-conversation-monitor-worker.ts",
      },
    }, null, 2));
    write(root, "app/runtime-modules.ts", [
      "export const RUNTIME_MODULES = [",
      "  { name: \"fastpath\", source_path: \"sidecars/fastpath/fastpath.mjs\" },",
      "  { name: \"lexical_sidecar\", source_path: \"sidecars/lexical-sidecar/lexical-sidecar.mjs\" },",
      "  { name: \"reranker_adapter\", source_path: \"sidecars/reranker-adapter/reranker-adapter.mjs\" },",
      "  { name: \"mem0_extractor\", source_path: \"sidecars/mem0-extractor/extractor.py\" },",
      "  { name: \"markdown_projection\", source_path: \"app/projection\" },",
      "];",
      "",
    ].join("\n"));
    write(root, "app/projection/index.ts", "export const moduleName = 'markdown_projection';\n");
    write(root, "app/source-mode.ts", "export const sourceMode = 'readonly';\n");
    write(root, "scripts/source-mode.ts", "import '../app/source-mode';\n");
    write(root, "scripts/run-conversation-monitor-worker.ts", "console.log('conversation monitor');\n");
    write(root, "sidecars/fastpath/fastpath.mjs", "export const name = 'fastpath';\n");
    write(root, "sidecars/fastpath/README.md", "# Fastpath sidecar\n");
    write(root, "sidecars/lexical-sidecar/lexical-sidecar.mjs", "export const name = 'lexical';\n");
    write(root, "sidecars/lexical-sidecar/README.md", "# Lexical sidecar\n");
    write(root, "sidecars/reranker-adapter/reranker-adapter.mjs", "export const name = 'reranker';\n");
    write(root, "sidecars/reranker-adapter/README.md", "# Reranker adapter\n");
    write(root, "sidecars/mem0-extractor/extractor.py", "NAME = 'mem0'\n");
    write(root, "sidecars/mem0-extractor/README.md", "# Mem0 extractor\n");
    write(root, "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs", "export const name = 'qdrant_proxy';\n");
    write(root, "sidecars/qdrant-proxy/README.md", "# Qdrant proxy\n");
    write(root, "sidecars/embedding-proxy/embedding-proxy.mjs", "export const name = 'embedding_proxy';\n");
    write(root, "sidecars/embedding-proxy/README.md", "# Embedding proxy\n");
    write(root, "docs/features.zh-CN.md", "# 功能总览\n\n## 成熟度\n");
    write(root, "docs/quickstart.zh-CN.md", "MEMORY_XX_RUNTIME_PROFILE=enhanced docker-compose --profile enhanced up --build -d\n");
    write(root, "docs/control-panel.zh-CN.md", "# 控制面板\n");
    write(root, "docs/policy-governance.zh-CN.md", "# Policy Engine\n");
    write(root, "docs/vector-runtime.zh-CN.md", "# Vector Runtime\n");
    write(root, "docs/agent-integration.zh-CN.md", "# Agent Integration\n");

    const result = await exportOpenSourceProject({ root, targetDir, apply: true, targetExplicit: true });

    assert.equal(result.ok, true);
    for (const file of [
      "app/runtime-modules.ts",
      "app/projection/index.ts",
      "app/source-mode.ts",
      "scripts/source-mode.ts",
      "scripts/run-conversation-monitor-worker.ts",
      "sidecars/fastpath/fastpath.mjs",
      "sidecars/fastpath/README.md",
      "sidecars/lexical-sidecar/lexical-sidecar.mjs",
      "sidecars/lexical-sidecar/README.md",
      "sidecars/reranker-adapter/reranker-adapter.mjs",
      "sidecars/reranker-adapter/README.md",
      "sidecars/mem0-extractor/extractor.py",
      "sidecars/mem0-extractor/README.md",
      "sidecars/qdrant-proxy/qdrant-collection-proxy.mjs",
      "sidecars/qdrant-proxy/README.md",
      "sidecars/embedding-proxy/embedding-proxy.mjs",
      "sidecars/embedding-proxy/README.md",
      "docs/features.zh-CN.md",
      "docs/quickstart.zh-CN.md",
      "docs/control-panel.zh-CN.md",
      "docs/policy-governance.zh-CN.md",
      "docs/vector-runtime.zh-CN.md",
      "docs/agent-integration.zh-CN.md",
    ]) {
      assert.equal(existsSync(path.join(targetDir, file)), true, `missing ${file}`);
    }

    const registry = readFileSync(path.join(targetDir, "app/runtime-modules.ts"), "utf8");
    assert.match(registry, /sidecars\/fastpath\/fastpath\.mjs/u);
    assert.match(registry, /sidecars\/lexical-sidecar\/lexical-sidecar\.mjs/u);
    assert.match(registry, /sidecars\/reranker-adapter\/reranker-adapter\.mjs/u);
    assert.match(registry, /sidecars\/mem0-extractor\/extractor\.py/u);
    assert.match(registry, /markdown_projection/u);
  });
});

test("open source preaudit allows the public release gate test", async () => {
  await withTempDir(async (root) => {
    write(root, "package.json", JSON.stringify({ name: "memory-xx" }));
    write(root, "tests/open-source-release.test.ts", [
      "import test from 'node:test';",
      "test('synthetic release gate', () => {});",
      "",
    ].join("\n"));

    const report = await buildOpenSourcePreauditReport({ root });

    assert.equal(report.ok, true);
    assert.deepEqual(report.blockers, []);
  });
});

test("open source export preserves manifest-declared full-stack capabilities", async () => {
  await withTempDir(async (parent) => {
    const root = path.join(parent, "private-source");
    const targetDir = path.join(parent, "memory-xx");
    write(root, "package.json", JSON.stringify({ name: "memory-xx" }, null, 2));
    write(root, "app/full-stack-capabilities.ts", "export const FULL_STACK_CAPABILITIES = [];\n");
    for (const capability of FULL_STACK_CAPABILITIES) {
      for (const source of capability.source_paths) {
        write(root, source, `export const capability = ${JSON.stringify(capability.name)};\n`);
      }
      for (const script of capability.script_paths) {
        write(root, script, `console.log(${JSON.stringify(capability.name)});\n`);
      }
    }

    const result = await exportOpenSourceProject({ root, targetDir, apply: true, targetExplicit: true });

    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(targetDir, "app/full-stack-capabilities.ts")), true);
    for (const capability of FULL_STACK_CAPABILITIES) {
      for (const source of capability.source_paths) {
        assert.equal(existsSync(path.join(targetDir, source)), true, `missing ${capability.name}:${source}`);
      }
      for (const script of capability.script_paths) {
        assert.equal(existsSync(path.join(targetDir, script)), true, `missing ${capability.name}:${script}`);
      }
    }
  });
});

test("parity audit allows only documented historical reference-only gaps", async () => {
  await withTempDir(async (parent) => {
    const referenceName = ["memory", "v2"].join("-");
    const referenceRoot = path.join(parent, referenceName);
    const publicRoot = path.join(parent, "memory-xx");
    write(referenceRoot, "package.json", JSON.stringify({
      scripts: {
        "memory:status": "node --import tsx scripts/memory-status.ts",
        "memory:quality": "node --import tsx scripts/memory-quality.ts",
      },
    }, null, 2));
    write(publicRoot, "package.json", JSON.stringify({
      scripts: {
        "memory:status": "node --import tsx scripts/memory-status.ts",
        "memory:quality": "node --import tsx scripts/memory-quality.ts",
        "smoke:runtime-profiles": "node --import tsx scripts/runtime-profile-smoke.ts",
      },
    }, null, 2));
    write(referenceRoot, "scripts/memory-status.ts", `console.log(${JSON.stringify(referenceName)});\n`);
    write(publicRoot, "scripts/memory-status.ts", "console.log('memory-xx');\n");
    write(referenceRoot, "scripts/memory-quality.ts", "console.log('quality');\n");
    write(publicRoot, "scripts/memory-quality.ts", "console.log('quality');\n");
    write(referenceRoot, `configs/${referenceName}.env.example`, `${["MEMORY", "V2"].join("_")}_DATABASE_URL=postgres://example\n`);
    write(publicRoot, "configs/memory-xx.env.example", "MEMORY_XX_DATABASE_URL=postgres://example\n");
    write(referenceRoot, "docs/生产闭环补齐方案.md", "# internal historical plan\n");
    write(referenceRoot, "app/server/http-handlers.ts.pre-bak-restore", "backup\n");

    const report = await buildParityAuditReport({ referenceRoot, publicRoot });

    assert.equal(report.ok, true);
    assert.deepEqual(report.missing_npm_scripts, []);
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.reference_only_blockers, []);
    assert.deepEqual([...report.reference_only_allowed].sort(), [
      "app/server/http-handlers.ts.pre-bak-restore",
      "docs/生产闭环补齐方案.md",
    ]);
  });
});

test("parity audit blocks missing public npm scripts and source files", async () => {
  await withTempDir(async (parent) => {
    const referenceName = ["memory", "v2"].join("-");
    const referenceRoot = path.join(parent, referenceName);
    const publicRoot = path.join(parent, "memory-xx");
    write(referenceRoot, "package.json", JSON.stringify({
      scripts: {
        "memory:status": "node --import tsx scripts/memory-status.ts",
        "memory:missing": "node --import tsx scripts/memory-missing.ts",
      },
    }, null, 2));
    write(publicRoot, "package.json", JSON.stringify({
      scripts: {
        "memory:status": "node --import tsx scripts/memory-status.ts",
      },
    }, null, 2));
    write(referenceRoot, "scripts/memory-status.ts", `console.log(${JSON.stringify(referenceName)});\n`);
    write(publicRoot, "scripts/memory-status.ts", "console.log('memory-xx');\n");
    write(referenceRoot, "scripts/memory-missing.ts", "console.log('missing');\n");

    const report = await buildParityAuditReport({ referenceRoot, publicRoot });

    assert.equal(report.ok, false);
    assert.deepEqual(report.missing_npm_scripts, ["memory:missing"]);
    assert.deepEqual(report.reference_only_blockers, ["scripts/memory-missing.ts"]);
    assert.match(report.blockers.join("\n"), /missing_npm_script:memory:missing/u);
    assert.match(report.blockers.join("\n"), /reference_only_file:scripts\/memory-missing\.ts/u);
  });
});
