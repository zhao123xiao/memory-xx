#!/usr/bin/env tsx
import "./test-harness/config.js";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Pool } from "pg";

import {
  buildLocalAgentProfile,
  validateLocalAgentId,
  type LocalAgentScopeGrant
} from "../app/local-agent-profile.js";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config.js";
import { hashToken, requireCliPermission, type MemoryPermission } from "../app/server/permissions.js";

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function newAgentToken(): string {
  return `memv2_${randomBytes(32).toString("base64url")}`;
}

function parseScope(raw: string): { scopeType: string; scopeId: string } {
  const [scopeType, ...rest] = raw.split(":");
  const scopeId = rest.join(":");
  if (!scopeType || !scopeId) throw new Error("--scope must use <scope_type>:<scope_id>");
  if (!["user", "project", "workspace", "global"].includes(scopeType)) {
    throw new Error("scope_type must be one of user, project, workspace, global");
  }
  return { scopeType, scopeId };
}

function parsePermissions(raw: string | undefined, fallback: readonly MemoryPermission[]): readonly MemoryPermission[] {
  const values = (raw?.trim() ? raw.split(",") : [...fallback])
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = new Set([
    "memory:read",
    "memory:write",
    "memory:feedback",
    "memory:governance_read",
    "memory:governance_apply",
    "memory:governance_revert",
    "memory:admin",
  ]);
  for (const value of values) {
    if (!allowed.has(value)) throw new Error(`Unsupported permission: ${value}`);
  }
  return values as MemoryPermission[];
}

async function upsertGrant(input: {
  readonly pool: Pool;
  readonly schema: string;
  readonly agentId: string;
  readonly grant: LocalAgentScopeGrant | {
    readonly scopeType: string;
    readonly scopeId: string;
    readonly permissions: readonly MemoryPermission[];
  };
  readonly expiresAt: string | null;
  readonly createdBy: string;
}): Promise<Record<string, unknown>> {
  const existing = await input.pool.query(
    `
      SELECT id
      FROM ${input.schema}.trusted_agent_scope_grants
      WHERE agent_id = $1
        AND scope_type = $2
        AND scope_id = $3
        AND revoked_at IS NULL
      LIMIT 1
    `,
    [input.agentId, input.grant.scopeType, input.grant.scopeId]
  );
  if (existing.rows[0]?.id) {
    const updated = await input.pool.query(
      `
        UPDATE ${input.schema}.trusted_agent_scope_grants
        SET permissions = $2,
            expires_at = $3::timestamptz,
            updated_at = now()
        WHERE id = $1
        RETURNING id, agent_id, scope_type, scope_id, permissions, expires_at, revoked_at, created_at, updated_at
      `,
      [existing.rows[0].id, input.grant.permissions, input.expiresAt]
    );
    return { ...updated.rows[0], action: "updated" };
  }
  const inserted = await input.pool.query(
    `
      INSERT INTO ${input.schema}.trusted_agent_scope_grants (
        id, agent_id, scope_type, scope_id, permissions, expires_at, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)
      RETURNING id, agent_id, scope_type, scope_id, permissions, expires_at, revoked_at, created_at, updated_at
    `,
    [randomUUID(), input.agentId, input.grant.scopeType, input.grant.scopeId, input.grant.permissions, input.expiresAt, input.createdBy]
  );
  return { ...inserted.rows[0], action: "inserted" };
}

async function audit(pool: Pool, schema: string): Promise<void> {
  const agents = await pool.query(
    `
      SELECT id, agent_id, permissions, expires_at, revoked_at, created_at, updated_at
      FROM ${schema}.trusted_agents
      ORDER BY revoked_at NULLS FIRST, agent_id ASC, created_at DESC
    `
  );
  const grants = await pool.query(
    `
      SELECT id, agent_id, scope_type, scope_id, permissions, expires_at, revoked_at, created_by, created_at, updated_at
      FROM ${schema}.trusted_agent_scope_grants
      ORDER BY revoked_at NULLS FIRST, agent_id ASC, scope_type ASC, scope_id ASC
    `
  );
  process.stdout.write(JSON.stringify({
    ok: true,
    active_agents: agents.rows.filter((row) => row.revoked_at === null).length,
    active_grants: grants.rows.filter((row) => row.revoked_at === null).length,
    agents: agents.rows,
    grants: grants.rows,
    policy: {
      admin_token: "human operations only",
      regular_agent_default: "read/write/feedback on project/workspace/agent-private scopes, owner/global read-only",
    },
  }, null, 2) + "\n");
}

async function main(): Promise<void> {
  await requireCliPermission("memory:admin");
  const command = process.argv[2] ?? "audit";
  const config = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    if (command === "audit" || command === "list") {
      await audit(pool, schema);
      return;
    }

    if (command === "create") {
      const agentId = validateLocalAgentId(process.argv[3] ?? argValue("--agent-id") ?? "");
      const profile = buildLocalAgentProfile({
        agentId,
        role: argValue("--role"),
        projectScopeId: argValue("--project"),
        allowUserWrite: hasFlag("--allow-user-write"),
        allowGlobalWrite: hasFlag("--allow-global-write"),
      });
      const existing = await pool.query(
        `SELECT id FROM ${schema}.trusted_agents WHERE agent_id = $1 AND revoked_at IS NULL`,
        [agentId]
      );
      if (existing.rows.length > 0 && !hasFlag("--rotate")) {
        throw new Error(`active trusted agent already exists for ${agentId}; rerun with --rotate to revoke old token first`);
      }
      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE ${schema}.trusted_agents SET revoked_at = now(), updated_at = now() WHERE agent_id = $1 AND revoked_at IS NULL`,
          [agentId]
        );
      }
      const token = newAgentToken();
      const expiresAt = argValue("--expires-at") ?? null;
      const inserted = await pool.query(
        `
          INSERT INTO ${schema}.trusted_agents (id, token_hash, agent_id, permissions, expires_at)
          VALUES ($1, $2, $3, $4, $5::timestamptz)
          RETURNING id, agent_id, permissions, expires_at, revoked_at, created_at
        `,
        [randomUUID(), hashToken(token), agentId, profile.permissions, expiresAt]
      );
      const grants = [];
      for (const grant of profile.grants) {
        grants.push(await upsertGrant({
          pool,
          schema,
          agentId,
          grant,
          expiresAt,
          createdBy: "memory:agent",
        }));
      }
      const wrapperUrl = process.env.MEMORY_XX_WRAPPER_URL?.replace(/\/+$/, "") ||
        `http://127.0.0.1:${process.env.MEMORY_XX_WRAPPER_PORT || "5100"}`;
      const envSnippet = [
        `MEMORY_XX_WRAPPER_URL=${wrapperUrl}`,
        `MEMORY_XX_API_TOKEN=${token}`,
        `MEMORY_XX_AGENT_ID=${profile.env.MEMORY_XX_AGENT_ID}`,
        `MEMORY_XX_DEFAULT_USER_SCOPE=${profile.env.MEMORY_XX_DEFAULT_USER_SCOPE}`,
        `MEMORY_XX_DEFAULT_WORKSPACE_SCOPE=${profile.env.MEMORY_XX_DEFAULT_WORKSPACE_SCOPE}`,
        ...(profile.env.MEMORY_XX_DEFAULT_PROJECT_SCOPE ? [`MEMORY_XX_DEFAULT_PROJECT_SCOPE=${profile.env.MEMORY_XX_DEFAULT_PROJECT_SCOPE}`] : []),
        `MEMORY_XX_DEFAULT_GLOBAL_SCOPE=${profile.env.MEMORY_XX_DEFAULT_GLOBAL_SCOPE}`,
      ].join("\n");
      const envFile = argValue("--env-file");
      if (envFile?.trim()) {
        mkdirSync(dirname(envFile), { recursive: true });
        writeFileSync(envFile, `${envSnippet}\n`, { mode: 0o600 });
        chmodSync(envFile, 0o600);
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        trusted_agent: inserted.rows[0],
        profile,
        grants,
        token,
        env_file: envFile?.trim() || null,
        env_snippet: envSnippet,
        examples: {
          recall: "POST /api/memory/xx/recall/query with Authorization: Bearer <token>",
          write: "POST /api/memory/xx/write with explicit scopeType/scopeId",
          feedback: "POST /api/memory/xx/unified/feedback",
        },
      }, null, 2) + "\n");
      return;
    }

    if (command === "grant") {
      const agentId = validateLocalAgentId(process.argv[3] ?? argValue("--agent-id") ?? "");
      const scope = parseScope(argValue("--scope") ?? "");
      const permissions = parsePermissions(argValue("--permissions"), ["memory:read"]);
      const grant = await upsertGrant({
        pool,
        schema,
        agentId,
        grant: { ...scope, permissions },
        expiresAt: argValue("--expires-at") ?? null,
        createdBy: "memory:agent:grant",
      });
      process.stdout.write(JSON.stringify({ ok: true, grant }, null, 2) + "\n");
      return;
    }

    if (command === "revoke-grant") {
      const grantId = argValue("--id");
      if (!grantId) throw new Error("revoke-grant requires --id=<grant_id>");
      const revoked = await pool.query(
        `
          UPDATE ${schema}.trusted_agent_scope_grants
          SET revoked_at = now(), updated_at = now()
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING id, agent_id, scope_type, scope_id, permissions, revoked_at
        `,
        [grantId]
      );
      process.stdout.write(JSON.stringify({ ok: true, revoked: revoked.rows }, null, 2) + "\n");
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
