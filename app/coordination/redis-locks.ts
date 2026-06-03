import { createLogger } from "../shared/logger";
const log = createLogger("redis-locks");
export interface WriteLock {
  readonly scope_id: string;
  readonly agent_id: string;
  readonly acquired_at: number;
  readonly ttl_ms: number;
}
const locks = new Map<string, WriteLock>();
const DEFAULT_TTL_MS = 30_000;
export async function acquireWriteLock(scopeId: string, agentId: string, ttlMs = DEFAULT_TTL_MS): Promise<boolean> {
  const existing = locks.get(scopeId);
  if (existing && Date.now() - existing.acquired_at < existing.ttl_ms) {
    if (existing.agent_id !== agentId) {
      log.warn("Write lock contention", { scopeId, holder: existing.agent_id, requester: agentId });
      return false;
    }
  }
  locks.set(scopeId, { scope_id: scopeId, agent_id: agentId, acquired_at: Date.now(), ttl_ms: ttlMs });
  return true;
}
export async function releaseWriteLock(scopeId: string, agentId: string): Promise<void> {
  const existing = locks.get(scopeId);
  if (existing && existing.agent_id === agentId) { locks.delete(scopeId); }
}
export function getActiveLocks(): readonly WriteLock[] {
  const now = Date.now();
  return [...locks.values()].filter((lock) => now - lock.acquired_at < lock.ttl_ms);
}
