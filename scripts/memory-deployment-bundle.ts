#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildMigrationPreflight } from "./platform/migration-preflight.js";
import { type PlatformRuntimeProfile } from "./platform/platform-doctor.js";
import { argValue, loadDotenvIfPresent, printJson } from "./lib/runtime-env.js";

loadDotenvIfPresent();

function profileArg(): PlatformRuntimeProfile {
  const raw = argValue("--profile") ?? "wsl-windows-gpu";
  if (raw === "linux-systemd" || raw === "wsl-windows-gpu" || raw === "windows-native" || raw === "docker-compose-local") {
    return raw;
  }
  throw new Error(`unsupported profile: ${raw}`);
}

async function optionalRead(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

async function main(): Promise<void> {
  const profile = profileArg();
  const output = path.resolve(argValue("--output") ?? path.join(process.cwd(), "reports", "deployment-bundles", `${profile}-${new Date().toISOString().replace(/[:.]/gu, "-")}`));
  await mkdir(output, { recursive: true });
  const preflight = await buildMigrationPreflight({ profile });
  const envExample = await optionalRead(path.join(process.cwd(), ".env.example"));
  const readme = [
    `# memory-xx deployment bundle: ${profile}`,
    "",
    "This bundle intentionally excludes live secrets. Copy env.template to a private .env and fill values locally.",
    "",
    "## Verify",
    `TMPDIR=/tmp npm run memory:migration-preflight -- --profile=${profile} --json`,
    "TMPDIR=/tmp npm run memory:doctor -- --target ops-ready --mode full --plan --json",
    "",
    "## Rollback",
    "TMPDIR=/tmp npm run memory:embedding-manifest -- rollback",
    "systemctl --user restart memory-xx-wrapper.service memory-xx-qdrant-projector-worker.service",
    "",
  ].join("\n");
  await writeFile(path.join(output, "README.md"), readme, "utf8");
  await writeFile(path.join(output, "env.template"), envExample || "MEMORY_XX_API_TOKEN=<set-private-token>\nMEMORY_XX_DATABASE_URL=<set-private-database-url>\n", "utf8");
  await writeFile(path.join(output, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`, "utf8");
  await writeFile(path.join(output, "profile.json"), `${JSON.stringify({ profile, generated_at: new Date().toISOString(), includes_live_secrets: false }, null, 2)}\n`, "utf8");
  printJson({ ok: true, profile, output, includes_live_secrets: false, preflight_status: preflight.status });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
