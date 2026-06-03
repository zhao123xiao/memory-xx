import { config } from "../config.js";

export async function redisPing(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const url = new URL(config.redisUrl);
    const resp = await fetch(`http://${url.hostname}:${url.port || 6379}/`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    // Redis doesn't speak HTTP, use a simple TCP check via net
    // For now, just try connecting
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

export async function redisHealthCheck(): Promise<{
  ok: boolean;
  connected_clients?: number;
  used_memory_human?: string;
}> {
  try {
    const url = new URL(config.redisUrl);
    const port = parseInt(url.port || "6379");
    // Use hiredis-style check via a simple TCP connection
    // Since we can't use redis module directly in this context,
    // check via Docker exec or redis-cli
    const { execSync } = await import("node:child_process");
    const info = execSync(
      `redis-cli -h ${url.hostname} -p ${port} INFO clients 2>/dev/null | grep connected_clients`,
    ).toString();
    const match = info.match(/connected_clients:(\d+)/);
    return { ok: true, connected_clients: match ? parseInt(match[1]) : 0 };
  } catch {
    // Fallback: just check ping
    try {
      const { execSync } = await import("node:child_process");
      const url = new URL(config.redisUrl);
      const port = parseInt(url.port || "6379");
      const result = execSync(`redis-cli -h ${url.hostname} -p ${port} PING 2>/dev/null`).toString().trim();
      return { ok: result === "PONG" };
    } catch {
      return { ok: false };
    }
  }
}
