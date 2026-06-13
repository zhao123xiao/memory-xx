#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import path from "node:path";

const KNOWLEDGE_MD_SCRIPT = "scripts/memory-knowledge-md.ts";
const USAGE = "Usage: tsx scripts/knowledge/ingest-directory.ts --dir=./docs --scope-id=project-alpha --token=$ADMIN_TOKEN [--with-qdrant]";

function arg(name: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing --${name}.\n${USAGE}`);
  return value;
}

function passthroughNumberArg(name: string): string[] {
  const value = arg(name);
  return value ? [`--${name}=${value}`] : [];
}

function main(): void {
  const dir = path.resolve(required("dir"));
  const scopeId = required("scope-id");
  const token = arg("token");
  const runId = arg("run-id") || `knowledge-dir-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const childArgs = [
    "--import",
    "tsx",
    KNOWLEDGE_MD_SCRIPT,
    "ingest",
    `--root=${dir}`,
    `--run-id=${runId}`,
    `--scope-id=${scopeId}`,
    "--apply",
    "--json",
    "--write-report",
    "--skip-state-probe",
    ...passthroughNumberArg("max-files"),
    ...passthroughNumberArg("max-bytes"),
    ...(flag("with-qdrant") ? ["--with-qdrant"] : []),
  ];
  const result = spawnSync("node", childArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(token ? { MEMORY_XX_CLI_TOKEN: token, MEMORY_XX_API_TOKEN: process.env.MEMORY_XX_API_TOKEN || token } : {}),
      MEMORY_XX_DEFAULT_SCOPE_ID: scopeId,
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `knowledge ingest failed with exit ${result.status}\n`);
    process.exitCode = result.status ?? 1;
    return;
  }
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  process.stdout.write(JSON.stringify({
    ok: output.ok === true,
    scope_id: scopeId,
    dir,
    run_id: runId,
    delegated_to: KNOWLEDGE_MD_SCRIPT,
    result: output,
  }, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
