#!/usr/bin/env tsx
import "./test-harness/config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildCodeGraph, filterCodeGraph } from "../app/code-graph.js";

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const root = path.resolve(argValue("--root") ?? process.cwd());
  const projectId = argValue("--project-id") ?? path.basename(root) || "unknown-project";
  const maxFiles = Number.parseInt(argValue("--max-files") ?? "500", 10);
  const limit = Number.parseInt(argValue("--limit") ?? "160", 10);
  const query = argValue("--query") ?? "";
  const includeTests = !hasFlag("--no-tests");
  const graph = filterCodeGraph(buildCodeGraph({ root, projectId, maxFiles, includeTests }), {
    query,
    limit,
  });

  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
    return;
  }

  const outDir = argValue("--out-dir") ??
    path.join(process.cwd(), "reports", "code-graph", timestamp());
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "code-graph.json");
  writeFileSync(outPath, JSON.stringify(graph, null, 2) + "\n");
  process.stdout.write(JSON.stringify({
    ok: true,
    out_dir: outDir,
    file: outPath,
    summary: graph.summary,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
