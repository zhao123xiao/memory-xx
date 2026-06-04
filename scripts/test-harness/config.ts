import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

function resolveEnvPath(): string {
  if (process.env.MEMORY_XX_ENV_PATH?.trim()) {
    return process.env.MEMORY_XX_ENV_PATH.trim();
  }

  const cwdEnvPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(cwdEnvPath)) {
    return cwdEnvPath;
  }

  return path.join(REPO_ROOT, ".env");
}

const ENV_PATH = resolveEnvPath();
export const envPath = ENV_PATH;

function readEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  } catch {}
  return env;
}

const envFile = readEnvFile(ENV_PATH);

for (const [key, value] of Object.entries(envFile)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

function env(key: string, fallback: string = ""): string {
  return process.env[key] || envFile[key] || fallback;
}

export interface TestConfig {
  wrapperUrl: string;
  fastpathUrl: string;
  lexicalUrl: string;
  qdrantUrl: string;
  redisUrl: string;
  gatewayUrl: string;
  wrapperToken: string;
  gatewayToken: string;
  dbUrl: string;
  dbSchema: string;
  qdrantCollection: string;
  projectRoot: string;
  evalBaselinePath: string;
  evalRunnerPath: string;
  reportDir: string;
}

const wrapperUrlFallback = `http://127.0.0.1:${env("MEMORY_XX_WRAPPER_PORT", "5100")}`;

export const config: TestConfig = {
  wrapperUrl: env("MEMORY_XX_WRAPPER_URL", wrapperUrlFallback).replace(/\/+$/, ""),
  fastpathUrl: "http://127.0.0.1:5200",
  lexicalUrl: "http://127.0.0.1:5210",
  qdrantUrl: env("MEMORY_XX_QDRANT_BASE_URL", "http://127.0.0.1:6333").replace(/\/+$/, ""),
  redisUrl: env("MEMORY_XX_REDIS_URL", "redis://127.0.0.1:6381/0"),
  gatewayUrl: env("OPENCLAW_GATEWAY_URL", env("MEMORY_XX_GATEWAY_URL", "http://127.0.0.1:18789")).replace(/\/+$/, ""),
  wrapperToken: env("MEMORY_XX_ADMIN_TOKEN", env("MEMORY_XX_API_TOKEN")),
  gatewayToken: env("OPENCLAW_GATEWAY_TOKEN"),
  dbUrl: env("MEMORY_XX_DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/memory_xx"),
  dbSchema: env("MEMORY_XX_DATABASE_SCHEMA", "memory_xx"),
  qdrantCollection: env("MEMORY_XX_QDRANT_COLLECTION", "memory-xx"),
  projectRoot: env("MEMORY_XX_PROJECT_ROOT", process.cwd()),
  evalBaselinePath: env("MEMORY_XX_EVAL_BASELINE_PATH", path.join(env("MEMORY_XX_PROJECT_ROOT", process.cwd()), "scripts/test-harness/baselines/benchmark-v1-baseline.json")),
  evalRunnerPath: env("MEMORY_XX_EVAL_RUNNER_PATH", path.join(env("MEMORY_XX_PROJECT_ROOT", process.cwd()), "scripts/test-harness/recall-quality-smoke.mjs")),
  reportDir: env("MEMORY_XX_REPORT_DIR", path.join(env("MEMORY_XX_PROJECT_ROOT", process.cwd()), "reports/memory-xx-tests")),
};

export function validateConfig(requiredKeys: (keyof TestConfig)[]): string[] {
  const missing: string[] = [];
  for (const key of requiredKeys) {
    if (!config[key]) missing.push(key);
  }
  return missing;
}

export function redactedConfig(): Record<string, string> {
  const c = { ...config } as unknown as Record<string, string>;
  for (const key of Object.keys(c)) {
    if (/token|password|key|secret/i.test(key) && c[key]) {
      c[key] = "****";
    }
    if (/url/i.test(key) && c[key]?.includes("@")) {
      c[key] = c[key].replace(/:\/\/[^@]+@/, "://****@");
    }
  }
  return c;
}
