#!/usr/bin/env tsx
import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import path from "node:path";

import { requireCliPermission } from "../app/server/permissions.js";

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

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 500)}`);
  return body;
}

async function qdrantSnapshot(): Promise<Record<string, unknown>> {
  const base = process.env.MEMORY_XX_QDRANT_BASE_URL?.replace(/\/+$/, "") || "http://127.0.0.1:6333";
  const headers: Record<string, string> = {};
  if (process.env.MEMORY_XX_QDRANT_API_KEY?.trim()) headers["api-key"] = process.env.MEMORY_XX_QDRANT_API_KEY.trim();
  const aliases = await fetchJson(`${base}/aliases`, { headers }) as any;
  const activeAlias = process.env.MEMORY_XX_QDRANT_ALIAS || "memory-xx-active";
  const aliasRow = aliases?.result?.aliases?.find?.((item: any) => item.alias_name === activeAlias);
  const target = aliasRow?.collection_name;
  const collection = target ? await fetchJson(`${base}/collections/${encodeURIComponent(target)}`, { headers }) : null;
  return {
    base_url: base,
    active_alias: activeAlias,
    active_collection: target ?? null,
    aliases,
    active_collection_info: collection,
  };
}

function copySystemdUnits(targetDir: string): string[] {
  const unitDir = "<linux-user-home>/.config/systemd/user";
  const copied: string[] = [];
  if (!existsSync(unitDir)) return copied;
  const names = readdirSync(unitDir)
    .filter((name) => /memory-xx|qdrant-projector/u.test(name))
    .filter((name) => statSync(path.join(unitDir, name)).isFile());
  const outDir = path.join(targetDir, "systemd-user-units");
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    copyFileSync(path.join(unitDir, name), path.join(outDir, name));
    copied.push(name);
  }
  return copied;
}

async function main(): Promise<void> {
  await requireCliPermission("memory:admin");
  const apply = hasFlag("--apply");
  const root = argValue("--dir") || path.join(process.cwd(), "backups", "memory-xx", timestamp());
  const envPath = process.env.MEMORY_XX_ENV_PATH || path.join(process.cwd(), ".env");
  const dbUrl = process.env.MEMORY_XX_DATABASE_URL;
  const schema = process.env.MEMORY_XX_DATABASE_SCHEMA || "memory_xx";
  if (!dbUrl) throw new Error("MEMORY_XX_DATABASE_URL is required");

  const plan = {
    ok: true,
    mode: apply ? "apply" : "dry_run",
    backup_dir: root,
    items: [
      "Postgres schema dump",
      "Qdrant alias and active collection metadata",
      ".env copy",
      "systemd user unit copies",
    ],
  };

  if (!apply) {
    process.stdout.write(JSON.stringify({
      ...plan,
      next: `rerun with --apply to create ${root}`,
    }, null, 2) + "\n");
    return;
  }

  mkdirSync(root, { recursive: true });
  const pgDumpPath = path.join(root, `${schema}.dump`);
  execFileSync("pg_dump", [
    dbUrl,
    "--format=custom",
    `--schema=${schema}`,
    `--file=${pgDumpPath}`,
  ], { stdio: "pipe" });

  const qdrant = await qdrantSnapshot();
  writeFileSync(path.join(root, "qdrant-active.json"), JSON.stringify(qdrant, null, 2) + "\n");

  let envCopied = false;
  if (existsSync(envPath)) {
    const envTarget = path.join(root, ".env");
    copyFileSync(envPath, envTarget);
    chmodSync(envTarget, 0o600);
    envCopied = true;
  }
  const units = copySystemdUnits(root);
  const manifest = {
    ...plan,
    created_at: new Date().toISOString(),
    postgres_dump: pgDumpPath,
    qdrant_active_collection: (qdrant as any).active_collection ?? null,
    env_copied: envCopied,
    systemd_units: units,
    restore_notes: [
      "Restore Postgres with pg_restore into the target database/schema after stopping writers.",
      "Qdrant active collection can be rebuilt from Postgres via projector; qdrant-active.json records the alias target.",
      "Review .env and systemd units before copying them back.",
    ],
  };
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
