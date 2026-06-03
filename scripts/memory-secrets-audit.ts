#!/usr/bin/env tsx
import { runSecretAudit } from "./security/secrets-audit.js";
import { argValue, hasArg, loadDotenvIfPresent, printJson } from "./lib/runtime-env.js";

loadDotenvIfPresent();

function rootsFromArg(): readonly string[] | undefined {
  const raw = argValue("--root") ?? argValue("--roots");
  if (!raw) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const report = runSecretAudit({ roots: rootsFromArg() });
  printJson(report);
  if (report.blocker_count > 0 && !hasArg("--no-fail")) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
