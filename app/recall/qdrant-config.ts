export interface MemoryXXQdrantConfig {
  readonly enabled: boolean;
  readonly base_url?: string;
  readonly api_key?: string;
  readonly collection_name?: string;
  readonly minimum_score?: number;
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readNumberEnv(name: string): number | undefined {
  const value = readTrimmedEnv(name);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function loadMemoryXXQdrantConfig(
  env: NodeJS.ProcessEnv = process.env
): MemoryXXQdrantConfig {
  const baseUrl = env.MEMORY_XX_QDRANT_BASE_URL?.trim();
  const collectionName = env.MEMORY_XX_QDRANT_COLLECTION?.trim();
  const apiKey = env.MEMORY_XX_QDRANT_API_KEY?.trim();
  const minimumScoreRaw = env.MEMORY_XX_QDRANT_MINIMUM_SCORE?.trim();
  const minimumScore = minimumScoreRaw ? Number(minimumScoreRaw) : undefined;

  return {
    enabled: Boolean(baseUrl && collectionName),
    base_url: baseUrl || undefined,
    collection_name: collectionName || undefined,
    api_key: apiKey || undefined,
    minimum_score: Number.isFinite(minimumScore) ? minimumScore : undefined
  };
}

export function resolveVectorRuntimeMode(
  config: MemoryXXQdrantConfig
): "postgres-primary" | "qdrant-primary" {
  return config.enabled ? "qdrant-primary" : "postgres-primary";
}

export function buildQdrantDockerConfigHint(
  config: MemoryXXQdrantConfig
): {
  readonly docker_managed: boolean;
  readonly base_url?: string;
  readonly collection_name?: string;
  readonly configured: boolean;
} {
  return {
    docker_managed: true,
    base_url: config.base_url,
    collection_name: config.collection_name,
    configured: config.enabled
  };
}
