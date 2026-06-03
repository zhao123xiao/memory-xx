import type { MemoryPermission } from "./server/permissions";
import { ScopeType } from "./shared/types";

export type LocalAgentRole = "regular" | "governance";

export interface LocalAgentScopeGrant {
  readonly scopeType: ScopeType.User | ScopeType.Project | ScopeType.Workspace | ScopeType.Global;
  readonly scopeId: string;
  readonly permissions: readonly MemoryPermission[];
  readonly purpose: string;
}

export interface LocalAgentProfile {
  readonly agentId: string;
  readonly role: LocalAgentRole;
  readonly permissions: readonly MemoryPermission[];
  readonly defaultRecallOrder: readonly string[];
  readonly grants: readonly LocalAgentScopeGrant[];
  readonly env: {
    readonly MEMORY_V2_AGENT_ID: string;
    readonly MEMORY_V2_DEFAULT_USER_SCOPE: string;
    readonly MEMORY_V2_DEFAULT_WORKSPACE_SCOPE: string;
    readonly MEMORY_V2_DEFAULT_PROJECT_SCOPE?: string;
    readonly MEMORY_V2_DEFAULT_GLOBAL_SCOPE: string;
  };
}

function readDefaultScope(envName: string, fallback: string): string {
  return process.env[envName]?.trim() || fallback;
}

export const LOCAL_AGENT_DEFAULTS = {
  userScopeId: readDefaultScope("MEMORY_V2_DEFAULT_USER_SCOPE", "current-instance-owner"),
  workspaceScopeId: readDefaultScope("MEMORY_V2_DEFAULT_WORKSPACE_SCOPE", "current-instance"),
  globalScopeId: readDefaultScope("MEMORY_V2_DEFAULT_GLOBAL_SCOPE", "global"),
} as const;

const RW_FEEDBACK: readonly MemoryPermission[] = ["memory:read", "memory:write", "memory:feedback"];
const READ_ONLY: readonly MemoryPermission[] = ["memory:read"];

export function validateLocalAgentId(agentId: string): string {
  const value = agentId.trim();
  if (!/^[a-z][a-z0-9._-]{1,63}$/u.test(value)) {
    throw new Error("agent_id must match ^[a-z][a-z0-9._-]{1,63}$");
  }
  return value;
}

export function normalizeLocalAgentRole(role: string | undefined): LocalAgentRole {
  return role === "governance" ? "governance" : "regular";
}

export function buildLocalAgentProfile(input: {
  readonly agentId: string;
  readonly role?: string;
  readonly projectScopeId?: string;
  readonly allowUserWrite?: boolean;
  readonly allowGlobalWrite?: boolean;
}): LocalAgentProfile {
  const agentId = validateLocalAgentId(input.agentId);
  const role = normalizeLocalAgentRole(input.role);
  const permissions: MemoryPermission[] = ["memory:read", "memory:write", "memory:feedback"];
  if (role === "governance") permissions.push("memory:governance_read", "memory:governance_apply");

  const grants: LocalAgentScopeGrant[] = [];
  if (input.projectScopeId?.trim()) {
    grants.push({
      scopeType: ScopeType.Project,
      scopeId: input.projectScopeId.trim(),
      permissions: RW_FEEDBACK,
      purpose: "current project memory",
    });
  }
  grants.push(
    {
      scopeType: ScopeType.Workspace,
      scopeId: LOCAL_AGENT_DEFAULTS.workspaceScopeId,
      permissions: RW_FEEDBACK,
      purpose: "current local runtime workspace",
    },
    {
      scopeType: ScopeType.User,
      scopeId: agentId,
      permissions: RW_FEEDBACK,
      purpose: "agent-private durable memory",
    },
    {
      scopeType: ScopeType.User,
      scopeId: LOCAL_AGENT_DEFAULTS.userScopeId,
      permissions: input.allowUserWrite ? RW_FEEDBACK : READ_ONLY,
      purpose: input.allowUserWrite ? "owner personal memory read/write" : "owner personal memory read-only",
    },
    {
      scopeType: ScopeType.Global,
      scopeId: LOCAL_AGENT_DEFAULTS.globalScopeId,
      permissions: input.allowGlobalWrite ? RW_FEEDBACK : READ_ONLY,
      purpose: input.allowGlobalWrite ? "explicit global memory read/write" : "global rules read-only",
    },
  );

  return {
    agentId,
    role,
    permissions,
    defaultRecallOrder: [
      ...(input.projectScopeId?.trim() ? [`project:${input.projectScopeId.trim()}`] : []),
      `workspace:${LOCAL_AGENT_DEFAULTS.workspaceScopeId}`,
      `user:${LOCAL_AGENT_DEFAULTS.userScopeId}`,
      `user:${agentId}`,
      `global:${LOCAL_AGENT_DEFAULTS.globalScopeId}`,
    ],
    grants,
    env: {
      MEMORY_V2_AGENT_ID: agentId,
      MEMORY_V2_DEFAULT_USER_SCOPE: LOCAL_AGENT_DEFAULTS.userScopeId,
      MEMORY_V2_DEFAULT_WORKSPACE_SCOPE: LOCAL_AGENT_DEFAULTS.workspaceScopeId,
      ...(input.projectScopeId?.trim() ? { MEMORY_V2_DEFAULT_PROJECT_SCOPE: input.projectScopeId.trim() } : {}),
      MEMORY_V2_DEFAULT_GLOBAL_SCOPE: LOCAL_AGENT_DEFAULTS.globalScopeId,
    },
  };
}
