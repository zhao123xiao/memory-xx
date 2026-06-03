// Skill registry — pluggable high-level memory operations.

import { createLogger } from "../shared/logger";
import type { SkillDefinition, SkillExecutor, SkillPermission, SkillResult } from "./types";

const log = createLogger("skill-registry");

interface RegisteredSkill {
  readonly definition: SkillDefinition;
  readonly executor: SkillExecutor;
}

export interface SkillExecutionOptions {
  readonly scope?: { readonly type: string; readonly id: string } | null;
}

export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();

  register(definition: SkillDefinition, executor: SkillExecutor): void {
    if (this.skills.has(definition.id)) {
      log.warn("Overwriting existing skill", { skillId: definition.id });
    }
    this.skills.set(definition.id, { definition, executor });
    log.info("Skill registered", { skillId: definition.id, name: definition.name });
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values()).map((s) => s.definition);
  }

  listByCategory(category: string): SkillDefinition[] {
    return this.list().filter((s) => s.category === category);
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id)?.definition;
  }

  async execute(id: string, params: Record<string, unknown>, permissions?: readonly SkillPermission[], options: SkillExecutionOptions = {}): Promise<SkillResult> {
    const skill = this.skills.get(id);
    if (!skill) {
      return {
        success: false,
        error: `Skill not found: ${id}`,
        audit: {
          skill_id: id,
          executed_at: new Date().toISOString(),
          duration_ms: 0,
        },
      };
    }

    const scopePolicy = skill.definition.scopePolicy ?? "none";
    if (scopePolicy === "explicit_scope_required" && !options.scope && !hasExplicitScope(params)) {
      return {
        success: false,
        error: "Skill requires an explicit scope",
        audit: {
          skill_id: id,
          executed_at: new Date().toISOString(),
          duration_ms: 0,
        },
      };
    }
    if (scopePolicy === "global_required" && !(permissions ?? []).some((permission) => permission.action.startsWith("memory:") && (permission.scope === undefined || permission.scope === "global"))) {
      return {
        success: false,
        error: "Skill requires a global memory permission",
        audit: {
          skill_id: id,
          executed_at: new Date().toISOString(),
          duration_ms: 0,
        },
      };
    }

    // Permission check
    const required = skill.definition.requiredPermissions;
    if (required && required.length > 0) {
      const granted = permissions ?? [];
      const missing = required.filter(
        (req) => !granted.some((g) => g.action === req.action && (!req.scope || g.scope === req.scope))
      );
      if (missing.length > 0) {
        return {
          success: false,
          error: `Missing required permissions: ${missing.map((m) => m.action).join(", ")}`,
          audit: {
            skill_id: id,
            executed_at: new Date().toISOString(),
            duration_ms: 0,
          },
        };
      }
    }

    // Apply defaults for missing optional params
    const resolved: Record<string, unknown> = {};
    for (const param of skill.definition.parameters) {
      if (params[param.name] !== undefined) {
        if (!matchesParameterType(params[param.name], param.type)) {
          return {
            success: false,
            error: `Invalid parameter type: ${param.name} must be ${param.type}`,
            audit: {
              skill_id: id,
              executed_at: new Date().toISOString(),
              duration_ms: 0,
            },
          };
        }
        resolved[param.name] = params[param.name];
      } else if (param.default !== undefined) {
        resolved[param.name] = param.default;
      } else if (param.required) {
        return {
          success: false,
          error: `Missing required parameter: ${param.name}`,
          audit: {
            skill_id: id,
            executed_at: new Date().toISOString(),
            duration_ms: 0,
          },
        };
      }
    }

    const start = Date.now();
    try {
      const result = await skill.executor(resolved);
      return {
        ...result,
        audit: {
          skill_id: id,
          executed_at: new Date().toISOString(),
          duration_ms: Date.now() - start,
        },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("Skill execution failed", { skillId: id, error: errorMessage });
      return {
        success: false,
        error: errorMessage,
        audit: {
          skill_id: id,
          executed_at: new Date().toISOString(),
          duration_ms: Date.now() - start,
        },
      };
    }
  }
}

function matchesParameterType(value: unknown, type: SkillDefinition["parameters"][number]["type"]): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  return typeof value === type;
}

function hasExplicitScope(params: Record<string, unknown>): boolean {
  if (typeof params.scope_type === "string" && typeof params.scope_id === "string") return true;
  const scopeHint = params.scope_hint;
  return typeof scopeHint === "object" &&
    scopeHint !== null &&
    !Array.isArray(scopeHint) &&
    typeof (scopeHint as Record<string, unknown>).scope_type === "string" &&
    typeof (scopeHint as Record<string, unknown>).scope_id === "string";
}
