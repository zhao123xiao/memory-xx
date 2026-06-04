import { createServer, type Server } from "node:http";
import { createRequestHandler, type RequestHandlerDeps } from "../app/server/http-server";
import { loadCorsConfig } from "../app/server/http-server";
import { InMemoryRequestMetrics } from "../app/server/metrics";
import { createPermissionChecker, type PermissionChecker } from "../app/server/permissions";
import { RateLimiter } from "../app/server/rate-limiter";
import { NoopRecallCache } from "../app/cache/redis-recall-cache";
import type { HandlerDeps } from "../app/server/http-handlers";
import { InMemoryWriteDatabase } from "../app";

export interface TestHarness {
  readonly baseUrl: string;
  readonly metrics: InMemoryRequestMetrics;
  readonly database: InMemoryWriteDatabase;
  close(): Promise<void>;
}

export async function createTestHarness(options?: {
  authToken?: string;
  adminToken?: string;
  env?: NodeJS.ProcessEnv;
  permissions?: PermissionChecker;
  rateLimitMax?: number;
  runtime?: HandlerDeps["runtime"];
}): Promise<TestHarness> {
  const metrics = new InMemoryRequestMetrics();
  const database = new InMemoryWriteDatabase();
  const recallCache = new NoopRecallCache();

  const env: Record<string, string> = {};
  if (options?.authToken) env.MEMORY_XX_API_TOKEN = options.authToken;
  if (options?.adminToken) env.MEMORY_XX_ADMIN_TOKEN = options.adminToken;
  Object.assign(env, options?.env ?? {});

  const permissions: PermissionChecker = options?.permissions ?? (options?.authToken
    ? createPermissionChecker(env)
    : {
        authorizeToken: async (_token, permission) => ({
          authenticated: true,
          allowed: true,
          required: permission,
          identity: { agentId: "test", permissions: ["memory:admin"], source: "admin_env" },
        }),
        authorizeRequest: async (_req, permission) => ({
          authenticated: true,
          allowed: true,
          required: permission,
          identity: { agentId: "test", permissions: ["memory:admin"], source: "admin_env" },
        }),
        authorizeScope: async ({ permission, scopeType, scopeId }) => ({
          authenticated: true,
          allowed: true,
          required: permission,
          identity: { agentId: "test", permissions: ["memory:admin"], source: "admin_env" },
          scopePolicyMode: "single_user",
          scopeAllowed: true,
          scope: { scopeType, scopeId },
        }),
        close: async () => undefined,
      });

  const rateLimiter = new RateLimiter({
    maxRequests: options?.rateLimitMax ?? 1000,
    windowMs: 60_000,
  });

  const handlerDeps: Partial<HandlerDeps> = {
    runtime: options?.runtime ?? null,
    writeDatabase: database,
    recallCache,
    projectionSyncService: null,
    permissions,
    env: env as NodeJS.ProcessEnv,
  };

  const corsConfig = loadCorsConfig({});

  const deps: RequestHandlerDeps = {
    permissions,
    rateLimiter,
    corsConfig,
    handlerDeps,
    metrics,
  };

  const handler = createRequestHandler(deps);
  const server = createServer(handler);

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        metrics,
        database,
        close: async () => {
          await permissions.close();
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

export async function request(
  baseUrl: string,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: options?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await res.json() : await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers, body };
}
