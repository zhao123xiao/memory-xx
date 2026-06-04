import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../db/adapters/postgres-config";

export type MemoryPermission =
  | "memory:read"
  | "memory:write"
  | "memory:feedback"
  | "memory:governance_read"
  | "memory:governance_apply"
  | "memory:governance_revert"
  | "memory:admin";

export interface AuthIdentity {
  readonly agentId: string;
  readonly permissions: readonly MemoryPermission[];
  readonly source: "legacy_env" | "admin_env" | "trusted_agents";
}

export interface PermissionDecision {
  readonly authenticated: boolean;
  readonly allowed: boolean;
  readonly required: MemoryPermission;
  readonly identity: AuthIdentity | null;
}

export interface ScopeGrantDecision extends PermissionDecision {
  readonly scopePolicyMode: "single_user" | "strict";
  readonly scopeAllowed: boolean;
  readonly scope?: {
    readonly scopeType: string;
    readonly scopeId: string;
  };
  readonly reason?: string;
}

export interface PermissionChecker {
  authorizeToken(token: string, permission: MemoryPermission): Promise<PermissionDecision>;
  authorizeScope(input: {
    readonly token: string;
    readonly permission: MemoryPermission;
    readonly scopeType: string;
    readonly scopeId: string;
  }): Promise<ScopeGrantDecision>;
  authorizeRequest(req: IncomingMessage, permission: MemoryPermission): Promise<PermissionDecision>;
  close(): Promise<void>;
}

const ALL_PERMISSIONS: readonly MemoryPermission[] = [
  "memory:read",
  "memory:write",
  "memory:feedback",
  "memory:governance_read",
  "memory:governance_apply",
  "memory:governance_revert",
  "memory:admin",
];

const LEGACY_DEFAULT_PERMISSIONS: readonly MemoryPermission[] = [
  "memory:read",
  "memory:write",
  "memory:feedback",
];

export function extractAuthToken(req: IncomingMessage): string {
  const bearer = req.headers["authorization"];
  if (typeof bearer === "string" && bearer.startsWith("Bearer ")) {
    return bearer.slice(7).trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") {
    return apiKey.trim();
  }
  return "";
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function normalizePermission(value: string): MemoryPermission | null {
  return ALL_PERMISSIONS.includes(value as MemoryPermission) ? value as MemoryPermission : null;
}

function parseLegacyPermissions(env: NodeJS.ProcessEnv): readonly MemoryPermission[] {
  const raw = env.MEMORY_XX_LEGACY_TOKEN_PERMISSIONS?.trim();
  if (!raw) return LEGACY_DEFAULT_PERMISSIONS;
  const requested = raw.split(",").map((item) => normalizePermission(item.trim())).filter((item): item is MemoryPermission => Boolean(item));
  return requested.filter((permission) => LEGACY_DEFAULT_PERMISSIONS.includes(permission));
}

function hasPermission(identity: AuthIdentity, required: MemoryPermission): boolean {
  return identity.permissions.includes("memory:admin") || identity.permissions.includes(required);
}

function decision(required: MemoryPermission, identity: AuthIdentity | null): PermissionDecision {
  return {
    authenticated: identity !== null,
    allowed: identity !== null && hasPermission(identity, required),
    required,
    identity,
  };
}

export function createPermissionChecker(env: NodeJS.ProcessEnv = process.env): PermissionChecker {
  const legacyToken = env.MEMORY_XX_API_TOKEN?.trim() ?? "";
  const legacyPermissions = parseLegacyPermissions(env);
  const adminToken = env.MEMORY_XX_ADMIN_TOKEN?.trim() ?? "";
  let pool: Pool | null = null;

  function resolveEnvIdentity(token: string): AuthIdentity | null {
    if (adminToken && constantTimeEqual(token, adminToken)) {
      return { agentId: "env-admin", permissions: ALL_PERMISSIONS, source: "admin_env" };
    }
    if (legacyToken && constantTimeEqual(token, legacyToken)) {
      return { agentId: "legacy-api-token", permissions: legacyPermissions, source: "legacy_env" };
    }
    return null;
  }

  async function getPool(): Promise<Pool | null> {
    if (pool) return pool;
    try {
      const config = loadMemoryXXPostgresConfig(env);
      pool = new Pool(createPostgresPoolConfig(config));
      return pool;
    } catch {
      return null;
    }
  }

  async function resolveTrustedAgentIdentity(token: string): Promise<AuthIdentity | null> {
    const db = await getPool();
    if (!db) return null;
    const config = loadMemoryXXPostgresConfig(env);
    const schema = quoteIdent(config.schema ?? "memory_xx");
    try {
      const result = await db.query<{
        agent_id: string;
        permissions: string[];
      }>(
        `
          SELECT agent_id, permissions
          FROM ${schema}.trusted_agents
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1
        `,
        [hashToken(token)]
      );
      const row = result.rows[0];
      if (!row) return null;
      const permissions = row.permissions.map(normalizePermission).filter((item): item is MemoryPermission => Boolean(item));
      return {
        agentId: row.agent_id,
        permissions,
        source: "trusted_agents",
      };
    } catch {
      return null;
    }
  }

  async function authorizeToken(token: string, permission: MemoryPermission): Promise<PermissionDecision> {
    if (!token) return decision(permission, null);
    const envIdentity = resolveEnvIdentity(token);
    if (envIdentity) return decision(permission, envIdentity);
    return decision(permission, await resolveTrustedAgentIdentity(token));
  }

  async function authorizeScope(input: {
    readonly token: string;
    readonly permission: MemoryPermission;
    readonly scopeType: string;
    readonly scopeId: string;
  }): Promise<ScopeGrantDecision> {
    const base = await authorizeToken(input.token, input.permission);
    const scope = { scopeType: input.scopeType, scopeId: input.scopeId };
    const mode = loadScopePolicyMode(env);
    if (!base.authenticated || !base.allowed) {
      return {
        ...base,
        scopePolicyMode: mode,
        scopeAllowed: false,
        scope,
        reason: base.authenticated ? "permission_denied" : "unauthenticated",
      };
    }
    if (mode === "single_user") {
      return { ...base, scopePolicyMode: mode, scopeAllowed: true, scope };
    }
    if (base.identity?.permissions.includes("memory:admin") || base.identity?.source === "admin_env") {
      return { ...base, scopePolicyMode: mode, scopeAllowed: true, scope, reason: "admin_bypass" };
    }
    if (base.identity?.source === "legacy_env") {
      return {
        ...base,
        allowed: false,
        scopePolicyMode: mode,
        scopeAllowed: false,
        scope,
        reason: "legacy_token_disallowed_in_strict_scope",
      };
    }
    if (!base.identity) {
      return { ...base, scopePolicyMode: mode, scopeAllowed: false, scope, reason: "missing_identity" };
    }
    const allowedByGrant = await hasScopeGrant(base.identity.agentId, input.scopeType, input.scopeId, input.permission);
    return {
      ...base,
      scopePolicyMode: mode,
      scopeAllowed: allowedByGrant,
      scope,
      reason: allowedByGrant ? "trusted_agent_scope_grant" : "scope_grant_missing",
      allowed: base.allowed && allowedByGrant,
    };
  }

  async function hasScopeGrant(
    agentId: string,
    scopeType: string,
    scopeId: string,
    permission: MemoryPermission
  ): Promise<boolean> {
    const db = await getPool();
    if (!db) return false;
    const config = loadMemoryXXPostgresConfig(env);
    const schema = quoteIdent(config.schema ?? "memory_xx");
    try {
      const result = await db.query<{ ok: boolean }>(
        `
          SELECT true AS ok
          FROM ${schema}.trusted_agent_scope_grants
          WHERE agent_id = $1
            AND scope_type = $2
            AND (scope_id = $3 OR scope_id = '*')
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND ($4 = ANY(permissions) OR 'memory:admin' = ANY(permissions))
          LIMIT 1
        `,
        [agentId, scopeType, scopeId, permission]
      );
      return Boolean(result.rows[0]?.ok);
    } catch {
      return false;
    }
  }

  return {
    authorizeToken,
    authorizeScope,
    authorizeRequest: (req, permission) => authorizeToken(extractAuthToken(req), permission),
    close: async () => {
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };
}

export function inspectTokenSeparation(env: NodeJS.ProcessEnv = process.env): {
  readonly ok: boolean;
  readonly legacy_configured: boolean;
  readonly admin_configured: boolean;
  readonly overlap: boolean;
} {
  const legacyToken = env.MEMORY_XX_API_TOKEN?.trim() ?? "";
  const adminToken = env.MEMORY_XX_ADMIN_TOKEN?.trim() ?? "";
  const overlap = legacyToken.length > 0 && adminToken.length > 0 && constantTimeEqual(legacyToken, adminToken);
  return {
    ok: !overlap,
    legacy_configured: legacyToken.length > 0,
    admin_configured: adminToken.length > 0,
    overlap,
  };
}

export function loadScopePolicyMode(env: NodeJS.ProcessEnv = process.env): "single_user" | "strict" {
  return env.MEMORY_XX_SCOPE_POLICY_MODE === "single_user" ? "single_user" : "strict";
}

export async function requireCliPermission(permission: MemoryPermission, env: NodeJS.ProcessEnv = process.env): Promise<AuthIdentity> {
  const token = env.MEMORY_XX_CLI_TOKEN?.trim() || env.MEMORY_XX_ADMIN_TOKEN?.trim() || env.MEMORY_XX_API_TOKEN?.trim() || "";
  const checker = createPermissionChecker(env);
  try {
    const result = await checker.authorizeToken(token, permission);
    if (!result.authenticated) {
      throw new Error(`unauthorized: token required for ${permission}`);
    }
    if (!result.allowed) {
      throw new Error(`forbidden: ${result.identity?.agentId ?? "unknown"} requires ${permission}`);
    }
    return result.identity!;
  } finally {
    await checker.close();
  }
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}
