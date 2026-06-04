#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { hashToken, requireCliPermission } from "../app/server/permissions.js";

function readArg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

async function main(): Promise<void> {
  await requireCliPermission("memory:admin");
  const config = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    if (process.argv.includes("--add")) {
      const token = readArg("token");
      const agentId = readArg("agent-id");
      const permissions = readArg("permissions").split(",").map((item) => item.trim()).filter(Boolean);
      if (!token || !agentId || permissions.length === 0) {
        throw new Error("--add requires --token, --agent-id, and --permissions=a,b");
      }
      const expiresAt = readArg("expires-at") || null;
      const result = await pool.query(
        `
          INSERT INTO ${schema}.trusted_agents (id, token_hash, agent_id, permissions, expires_at)
          VALUES ($1, $2, $3, $4, $5::timestamptz)
          RETURNING id, agent_id, permissions, expires_at, revoked_at, created_at
        `,
        [randomUUID(), hashToken(token), agentId, permissions, expiresAt]
      );
      process.stdout.write(JSON.stringify({ ok: true, trusted_agent: result.rows[0] }, null, 2) + "\n");
      return;
    }

    if (process.argv.includes("--remove")) {
      const id = readArg("id");
      const tokenHash = readArg("token-hash");
      if (!id && !tokenHash) throw new Error("--remove requires --id or --token-hash");
      const result = await pool.query(
        `
          UPDATE ${schema}.trusted_agents
          SET revoked_at = now(), updated_at = now()
          WHERE revoked_at IS NULL
            AND (($1::text IS NOT NULL AND id = $1) OR ($2::text IS NOT NULL AND token_hash = $2))
          RETURNING id, agent_id, permissions, expires_at, revoked_at
        `,
        [id || null, tokenHash || null]
      );
      process.stdout.write(JSON.stringify({ ok: true, revoked: result.rows }, null, 2) + "\n");
      return;
    }

    const result = await pool.query(
      `
        SELECT id, agent_id, permissions, scopes, expires_at, revoked_at, created_at, updated_at
        FROM ${schema}.trusted_agents
        ORDER BY created_at DESC
        LIMIT 200
      `
    );
    process.stdout.write(JSON.stringify({ ok: true, trusted_agents: result.rows }, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
