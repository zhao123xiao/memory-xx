import { createLogger } from "../shared/logger";

const log = createLogger("intelligence-config");

export interface IntelligenceConfig {
  readonly provider: "native" | "mem0";
  readonly mem0Url: string;
  readonly mem0OfficialPath: string;
  readonly mem0PreferOfficial: boolean;
  readonly mem0StrategyVersion: "v1" | "v2";
  readonly nativeFallback: boolean;
  readonly compareSampleRate: number;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: "openai" | "anthropic";
  readonly apiKey: string;
  readonly fallbackModel: string;
  readonly fallbackEndpoint: string;
  readonly fallbackProtocol: "openai" | "anthropic";
  readonly fallbackApiKey: string;
  readonly primaryTimeoutMs: number;
  readonly fallbackTimeoutMs: number;
  readonly maxRetries: number;
  readonly lowConfidenceThreshold: number;
  readonly maxTokens: number;
  readonly llmCircuit: {
    readonly windowMs: number;
    readonly minCalls: number;
    readonly failureRate: number;
    readonly cooldownMs: number;
  };
}

function warnInvalidEnv(name: string, value: string | undefined, fallback: number | string): void {
  if (value !== undefined && value.trim() !== "") {
    log.warn("Invalid environment value; using fallback", { name, value, fallback });
  }
}

function parsePositiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  warnInvalidEnv(name, value, fallback);
  return fallback;
}

function parseFiniteNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  const parsed = Number.parseFloat(value ?? "");
  if (Number.isFinite(parsed)) return parsed;
  warnInvalidEnv(name, value, fallback);
  return fallback;
}

function parseRangedIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = parsePositiveIntEnv(env, name, fallback);
  if (value >= min && value <= max) return value;
  throw new Error(`${name} must be in range ${min}-${max}.`);
}

function parseRangedFloatEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = parseFiniteNumberEnv(env, name, fallback);
  if (value >= min && value <= max) return value;
  throw new Error(`${name} must be in range ${min}-${max}.`);
}

function parseProtocol(value: string | undefined, endpoint: string): "openai" | "anthropic" {
  if (value === "anthropic" || value === "openai") return value;
  return /\/anthropic(?:\/|$)/i.test(endpoint) ? "anthropic" : "openai";
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function openAIChatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = normalizeUrl(baseUrl);
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return trimmed + "/chat/completions";
}

function resolveOpenAIEndpoint(endpoint: string | undefined, baseUrl: string | undefined, fallback: string): string {
  const configuredBase = baseUrl?.trim();
  if (configuredBase) return openAIChatCompletionsEndpoint(configuredBase);
  return endpoint?.trim() || fallback;
}

export function loadIntelligenceConfig(env: NodeJS.ProcessEnv = process.env): IntelligenceConfig {
  const legacyTimeout = parsePositiveIntEnv(env, "MEMORY_INTELLIGENCE_TIMEOUT_MS", 12000);
  const provider = env.MEMORY_INTELLIGENCE_PROVIDER === "mem0" ? "mem0" : "native";
  const mem0StrategyVersion = env.MEMORY_INTELLIGENCE_MEM0_STRATEGY_VERSION === "v2" ? "v2" : "v1";
  const endpoint = resolveOpenAIEndpoint(
    env.MEMORY_INTELLIGENCE_ENDPOINT,
    env.MEMORY_INTELLIGENCE_BASE_URL,
    "http://127.0.0.1:8081/v3/chat/completions",
  );
  const fallbackEndpoint = resolveOpenAIEndpoint(
    env.MEMORY_INTELLIGENCE_FALLBACK_ENDPOINT,
    env.MEMORY_INTELLIGENCE_FALLBACK_BASE_URL,
    "",
  );
  return {
    provider,
    mem0Url: (env.MEMORY_INTELLIGENCE_MEM0_URL || "http://127.0.0.1:5220").replace(/\/+$/, ""),
    mem0OfficialPath: env.MEMORY_INTELLIGENCE_MEM0_OFFICIAL_PATH || "/memories/add",
    mem0PreferOfficial: env.MEMORY_INTELLIGENCE_MEM0_PREFER_OFFICIAL !== "false",
    mem0StrategyVersion,
    nativeFallback: env.MEMORY_INTELLIGENCE_NATIVE_FALLBACK !== "false",
    compareSampleRate: Math.max(0, Math.min(1, parseFiniteNumberEnv(env, "MEMORY_INTELLIGENCE_COMPARE_SAMPLE_RATE", 0))),
    model: env.MEMORY_INTELLIGENCE_MODEL || "qwen3-8b",
    endpoint,
    protocol: parseProtocol(env.MEMORY_INTELLIGENCE_PROTOCOL, endpoint),
    apiKey: env.MEMORY_INTELLIGENCE_API_KEY || "",
    fallbackModel: env.MEMORY_INTELLIGENCE_FALLBACK_MODEL || "",
    fallbackEndpoint,
    fallbackProtocol: parseProtocol(env.MEMORY_INTELLIGENCE_FALLBACK_PROTOCOL, fallbackEndpoint),
    fallbackApiKey: env.MEMORY_INTELLIGENCE_FALLBACK_API_KEY || "",
    primaryTimeoutMs: parsePositiveIntEnv(env, "MEMORY_INTELLIGENCE_PRIMARY_TIMEOUT_MS", Math.min(legacyTimeout, 12000)),
    fallbackTimeoutMs: parsePositiveIntEnv(env, "MEMORY_INTELLIGENCE_FALLBACK_TIMEOUT_MS", 25000),
    maxRetries: parsePositiveIntEnv(env, "MEMORY_INTELLIGENCE_MAX_RETRIES", 1),
    lowConfidenceThreshold: parseFiniteNumberEnv(env, "MEMORY_INTELLIGENCE_LOW_CONFIDENCE_THRESHOLD", 0.75),
    maxTokens: parsePositiveIntEnv(env, "MEMORY_INTELLIGENCE_MAX_TOKENS", 256),
    llmCircuit: {
      windowMs: parseRangedIntEnv(env, "MEMORY_XX_LLM_CIRCUIT_WINDOW_MS", 60_000, 1_000, 600_000),
      minCalls: parseRangedIntEnv(env, "MEMORY_XX_LLM_CIRCUIT_MIN_CALLS", 5, 1, 100),
      failureRate: parseRangedFloatEnv(env, "MEMORY_XX_LLM_CIRCUIT_FAILURE_RATE", 0.5, 0, 1),
      cooldownMs: parseRangedIntEnv(env, "MEMORY_XX_LLM_CIRCUIT_COOLDOWN_MS", 30_000, 1_000, 600_000),
    },
  };
}
