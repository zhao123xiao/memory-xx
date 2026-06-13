#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = path.resolve(
  process.env.MEMORY_XX_PARITY_SOURCE_ROOT ?? path.join(process.cwd(), "..", "memory-v2")
);

if (!existsSync(sourceRoot)) {
  process.stdout.write(
    `Skipping memory-v2 parity audit; sibling memory-v2 checkout is not available at ${sourceRoot}.\n`
  );
  process.exit(0);
}

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmBin,
  ["run", "memory:parity-audit", "--", "--fail-on-missing", "--source-root", sourceRoot],
  { stdio: "inherit" }
);

if (result.error) {
  process.stderr.write(`Failed to run memory-v2 parity audit: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
