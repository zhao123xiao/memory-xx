import { LONG_TERM_SCOPE_TYPES, RUNTIME_SCOPE_TYPES, ScopeType } from "../shared";
import { RecallError, RecallErrorCode } from "./errors";
import {
  type RecallRequest,
  type RecallScopeContext,
  type RecallScopeRef,
  type ResolvedScopeSet
} from "./types";

const LONG_TERM_SCOPE_TYPE_SET = new Set<ScopeType>(LONG_TERM_SCOPE_TYPES);
const RUNTIME_SCOPE_TYPE_SET = new Set<ScopeType>(RUNTIME_SCOPE_TYPES);
const CANONICAL_LEDGER_WORKSPACE_ID = "memory-ledger";
const LIVE_DEFAULT_WORKSPACE_ID = "current-instance";
const MEMORY_MD_HEADER_SCOPE_QUERIES = new Set([
  "system decisions",
  "project index",
  "persona"
]);

export interface RuntimeScopeContextAdapter {
  get_runtime_scopes(input: {
    run_id?: string;
    task_id?: string;
  }): Promise<RecallScopeRef[]>;
}

export interface ScopeAccessPolicy {
  get_forbidden_scopes(input: {
    requested_scopes: RecallScopeRef[];
    scope_context: RecallScopeContext;
  }): Promise<RecallScopeRef[]> | RecallScopeRef[];
}

export interface TeamScopeInheritancePolicy {
  readonly workspace_id?: string;
  readonly include_global?: boolean;
}

function envFlagEnabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(
    (env[name] ?? "").trim().toLowerCase()
  );
}

function envFlagDisabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return ["0", "false", "no", "off", "disabled"].includes(
    (env[name] ?? "").trim().toLowerCase()
  );
}

export function loadTeamScopeInheritancePolicy(
  env: NodeJS.ProcessEnv = process.env
): TeamScopeInheritancePolicy | undefined {
  if (!envFlagEnabled(env, "MEMORY_XX_TEAM_SCOPE_INHERITANCE_ENABLED")) {
    return undefined;
  }

  const workspaceId = (
    env.MEMORY_XX_TEAM_WORKSPACE_SCOPE_ID ??
    env.MEMORY_XX_DEFAULT_WORKSPACE_SCOPE ??
    env.MEMORY_XX_DEFAULT_WORKSPACE_SCOPE_ID ??
    ""
  ).trim();
  const includeGlobal = envFlagDisabled(env, "MEMORY_XX_TEAM_SCOPE_INCLUDE_GLOBAL")
    ? false
    : envFlagEnabled(env, "MEMORY_XX_TEAM_SCOPE_INCLUDE_GLOBAL");

  if (!workspaceId && !includeGlobal) {
    return undefined;
  }

  return {
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    include_global: includeGlobal
  };
}

function uniqueScopes(scopes: RecallScopeRef[]): RecallScopeRef[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = `${scope.type}:${scope.id}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeHeaderLookupQuery(query: string | undefined): string {
  return (query ?? "")
    .trim()
    .toLowerCase()
    .replace(/[“”‘’'"`]/g, "")
    .replace(/[._/\\:-]+/g, " ")
    .replace(/[()\[\]{}（）【】]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldIncludeCanonicalLedgerWorkspace(request: RecallRequest): boolean {
  return (
    request.scope_context.workspace_id === LIVE_DEFAULT_WORKSPACE_ID &&
    MEMORY_MD_HEADER_SCOPE_QUERIES.has(normalizeHeaderLookupQuery(request.query))
  );
}

function buildLongTermScopes(
  request: RecallRequest,
  inheritance?: TeamScopeInheritancePolicy
): RecallScopeRef[] {
  const scopes: RecallScopeRef[] = [];
  const scopeContext = request.scope_context;
  const hasProjectScope = (scopeContext.project_ids?.length ?? 0) > 0;

  if (scopeContext.user_id) {
    scopes.push({ type: ScopeType.User, id: scopeContext.user_id });
  }

  for (const projectId of scopeContext.project_ids ?? []) {
    scopes.push({ type: ScopeType.Project, id: projectId });
  }

  if (scopeContext.workspace_id) {
    scopes.push({ type: ScopeType.Workspace, id: scopeContext.workspace_id });
  } else if (hasProjectScope && inheritance?.workspace_id?.trim()) {
    scopes.push({ type: ScopeType.Workspace, id: inheritance.workspace_id.trim() });
  }

  if (shouldIncludeCanonicalLedgerWorkspace(request)) {
    scopes.push({ type: ScopeType.Workspace, id: CANONICAL_LEDGER_WORKSPACE_ID });
  }

  if (scopeContext.include_global) {
    scopes.push({ type: ScopeType.Global, id: "global" });
  } else if (hasProjectScope && inheritance?.include_global) {
    scopes.push({ type: ScopeType.Global, id: "global" });
  }

  return uniqueScopes(scopes);
}

function validateRuntimeScopes(runtimeScopes: RecallScopeRef[]): RecallScopeRef[] {
  return uniqueScopes(
    runtimeScopes.filter((scope) => RUNTIME_SCOPE_TYPE_SET.has(scope.type))
  );
}

export async function resolveAllowedScopeSet(
  request: RecallRequest,
  dependencies: {
    runtime_scope_adapter?: RuntimeScopeContextAdapter;
    access_policy?: ScopeAccessPolicy;
    team_scope_inheritance?: TeamScopeInheritancePolicy;
  } = {}
): Promise<ResolvedScopeSet> {
  const longTermScopes = buildLongTermScopes(request, dependencies.team_scope_inheritance);
  if (longTermScopes.length === 0) {
    throw new RecallError(
      RecallErrorCode.InvalidScopeContext,
      "scope_context must contain at least one long-term scope"
    );
  }

  const nonLongTerm = longTermScopes.filter(
    (scope) => !LONG_TERM_SCOPE_TYPE_SET.has(scope.type)
  );
  if (nonLongTerm.length > 0) {
    throw new RecallError(
      RecallErrorCode.InvalidScopeContext,
      "scope_context contains a non-canonical long-term scope"
    );
  }

  if (dependencies.access_policy) {
    const forbiddenScopes = await dependencies.access_policy.get_forbidden_scopes({
      requested_scopes: longTermScopes,
      scope_context: request.scope_context
    });

    if (forbiddenScopes.length > 0) {
      throw new RecallError(
        RecallErrorCode.ScopeForbidden,
        "requested scope is forbidden",
        {
          forbidden_scopes: forbiddenScopes
        }
      );
    }
  }

  const degradeReasons: string[] = [];
  let runtimeScopes: RecallScopeRef[] = [];
  const runtimeRequested =
    request.scope_context.runtime?.run_id ||
    request.scope_context.runtime?.task_id;

  if (runtimeRequested) {
    if (!dependencies.runtime_scope_adapter) {
      degradeReasons.push("runtime_scope_unavailable");
    } else {
      try {
        runtimeScopes = validateRuntimeScopes(
          await dependencies.runtime_scope_adapter.get_runtime_scopes({
            run_id: request.scope_context.runtime?.run_id,
            task_id: request.scope_context.runtime?.task_id
          })
        );
      } catch {
        degradeReasons.push("runtime_scope_unavailable");
      }
    }
  }

  return {
    long_term_scopes: longTermScopes,
    runtime_scopes: runtimeScopes,
    allowed_scope_set: uniqueScopes([...longTermScopes, ...runtimeScopes]),
    degraded: degradeReasons.length > 0,
    degrade_reasons: degradeReasons
  };
}
