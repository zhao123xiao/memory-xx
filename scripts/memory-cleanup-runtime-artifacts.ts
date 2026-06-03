#!/usr/bin/env tsx
import path from "node:path";

import { cleanupRuntimeArtifacts } from "../app/ops/runtime-artifacts-cleanup";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const rootDir = path.resolve(argValue("--root") ?? process.cwd());
  const archiveDir = argValue("--archive-dir");
  const result = await cleanupRuntimeArtifacts({ rootDir, archiveDir, apply });
  process.stdout.write(JSON.stringify({
    ok: true,
    mode: apply ? "apply" : "dry_run",
    ...result
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2) + "\n");
  process.exitCode = 1;
});
