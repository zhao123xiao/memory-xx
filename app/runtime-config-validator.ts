export interface RuntimeConfigValidationResult {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export function validateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfigValidationResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!env.MEMORY_XX_DATABASE_URL?.trim()) {
    blockers.push("memory_xx_database_url_missing");
  }
  if (!env.MEMORY_XX_API_TOKEN?.trim()) {
    warnings.push("memory_xx_api_token_missing");
  }
  if (!env.OPENAI_API_KEY?.trim() && !env.EMBEDDING_API_KEY?.trim()) {
    warnings.push("embedding_api_key_missing");
  }
  if (env.MEMORY_XX_ADMIN_TOKEN?.trim() && env.MEMORY_XX_ADMIN_TOKEN === env.MEMORY_XX_API_TOKEN) {
    blockers.push("admin_token_matches_legacy_token");
  }

  return { ok: blockers.length === 0, blockers, warnings };
}
