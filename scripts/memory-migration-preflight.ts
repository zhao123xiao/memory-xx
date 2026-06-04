#!/usr/bin/env tsx
import { buildMigrationPreflight } from "./platform/migration-preflight.js";
import { type PlatformRuntimeProfile } from "./platform/platform-doctor.js";
import { argValue, loadDotenvIfPresent, printJson } from "./lib/runtime-env.js";

loadDotenvIfPresent();

function profileArg(): PlatformRuntimeProfile | undefined {
  const raw = argValue("--profile");
  if (!raw) return undefined;
  if (raw === "linux-systemd" || raw === "wsl-windows-gpu" || raw === "windows-native" || raw === "docker-compose-local") {
    return raw;
  }
  throw new Error(`unsupported profile: ${raw}`);
}

async function main(): Promise<void> {
  const report = await buildMigrationPreflight({ profile: profileArg() });
  printJson(report);
  if (!report.ok) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
