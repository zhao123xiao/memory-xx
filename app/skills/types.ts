// Skill types — high-level memory operation definitions.

export interface SkillParameter {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "array" | "object";
  readonly description: string;
  readonly required?: boolean;
  readonly default?: unknown;
}

export interface SkillPermission {
  readonly action: string;
  readonly scope?: string;
}

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: "recall" | "write" | "maintenance" | "analysis";
  readonly sideEffects?: "none" | "read" | "write" | "maintenance";
  readonly scopePolicy?: "none" | "explicit_scope_required" | "global_required";
  readonly parameters: readonly SkillParameter[];
  readonly requiredPermissions?: readonly SkillPermission[];
}

export interface SkillExecutorResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface SkillResult extends SkillExecutorResult {
  readonly audit: {
    readonly skill_id: string;
    readonly executed_at: string;
    readonly duration_ms: number;
  };
}

export type SkillExecutor = (params: Record<string, unknown>) => Promise<SkillExecutorResult>;
