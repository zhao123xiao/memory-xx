import { ScopeType } from "../../shared";
import type { RuntimeScopeContextAdapter } from "../../recall";
import type { RuntimeContextPort } from "../ports";
import type { CoordinationScopeRef } from "../types";

function uniqueRuntimeScopes(scopes: readonly CoordinationScopeRef[]): CoordinationScopeRef[] {
  const seen = new Set<string>();
  const filtered: CoordinationScopeRef[] = [];

  for (const scope of scopes) {
    if (scope.type !== ScopeType.Run && scope.type !== ScopeType.Task) {
      continue;
    }

    const key = `${scope.type}:${scope.id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    filtered.push(scope);
  }

  return filtered;
}

export class CoordinationRuntimeScopeAdapter implements RuntimeScopeContextAdapter {
  private readonly runtimeContextPort: RuntimeContextPort;
  private readonly nowProvider: () => number;

  constructor(
    runtimeContextPort: RuntimeContextPort,
    nowProvider: () => number = () => Date.now()
  ) {
    this.runtimeContextPort = runtimeContextPort;
    this.nowProvider = nowProvider;
  }

  async get_runtime_scopes(input: {
    run_id?: string;
    task_id?: string;
  }): Promise<CoordinationScopeRef[]> {
    const now = this.nowProvider();
    const scopes: CoordinationScopeRef[] = [];
    let resolvedRunId = input.run_id;

    if (input.task_id !== undefined) {
      const taskContext = await this.runtimeContextPort.getTaskContext(input.task_id, now);
      if (taskContext !== null) {
        scopes.push(...taskContext.scopes);
        resolvedRunId ??= taskContext.parentRunId;
      }
    }

    if (resolvedRunId !== undefined) {
      const runContext = await this.runtimeContextPort.getRunContext(resolvedRunId, now);
      if (runContext !== null) {
        scopes.push(...runContext.scopes);
      }
    }

    return uniqueRuntimeScopes(scopes);
  }
}
