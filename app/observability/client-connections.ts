import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MemoryClientTransport = "http" | "mcp" | "control_panel" | "worker" | "unknown";

export interface MemoryClientActivityInput {
  readonly agentId?: string | null;
  readonly identitySource?: string | null;
  readonly transport: MemoryClientTransport;
  readonly endpoint?: string | null;
  readonly method?: string | null;
  readonly remoteAddress?: string | null;
  readonly userAgent?: string | null;
  readonly status?: number | null;
  readonly permissions?: readonly string[] | null;
  readonly clientName?: string | null;
  readonly error?: string | null;
}

export interface MemoryClientConnectionRecord {
  readonly connection_id: string;
  readonly agent_id: string;
  readonly identity_source: string;
  readonly transport: MemoryClientTransport;
  readonly endpoint: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly request_count: number;
  readonly methods: readonly string[];
  readonly permissions: readonly string[];
  readonly remote_address?: string;
  readonly user_agent?: string;
  readonly client_name?: string;
  readonly last_status?: number;
  readonly last_error?: string;
}

interface StoreShape {
  readonly updated_at: string;
  readonly connections: readonly MemoryClientConnectionRecord[];
}

const MAX_CONNECTION_RECORDS = 200;

function runtimeDir(): string {
  return process.env.MEMORY_V2_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
}

export function memoryClientConnectionsPath(): string {
  return join(runtimeDir(), "memory-xx-client-connections.json");
}

function readStore(): StoreShape {
  const path = memoryClientConnectionsPath();
  if (!existsSync(path)) return { updated_at: new Date(0).toISOString(), connections: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreShape>;
    return {
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString(),
      connections: Array.isArray(parsed.connections) ? parsed.connections as MemoryClientConnectionRecord[] : [],
    };
  } catch {
    return { updated_at: new Date(0).toISOString(), connections: [] };
  }
}

function writeStore(store: StoreShape): void {
  const path = memoryClientConnectionsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}

function normalize(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 240) : fallback;
}

function recordKey(record: Pick<MemoryClientConnectionRecord, "agent_id" | "identity_source" | "transport" | "endpoint">): string {
  return `${record.agent_id}\n${record.identity_source}\n${record.transport}\n${record.endpoint}`;
}

export function recordMemoryClientActivity(input: MemoryClientActivityInput): void {
  const now = new Date().toISOString();
  const agentId = normalize(input.agentId, "unknown-agent");
  const identitySource = normalize(input.identitySource, "unknown-source");
  const endpoint = normalize(input.endpoint, "unknown-endpoint");
  const method = normalize(input.method, "unknown-method");
  const store = readStore();
  const existing = new Map(store.connections.map((item) => [recordKey(item), item]));
  const key = recordKey({ agent_id: agentId, identity_source: identitySource, transport: input.transport, endpoint });
  const previous = existing.get(key);
  const methods = new Set<string>(previous?.methods ?? []);
  methods.add(method);
  const permissions = new Set<string>(previous?.permissions ?? []);
  for (const permission of input.permissions ?? []) permissions.add(permission);
  const next: MemoryClientConnectionRecord = {
    connection_id: previous?.connection_id ?? `client_connection_${randomUUID()}`,
    agent_id: agentId,
    identity_source: identitySource,
    transport: input.transport,
    endpoint,
    first_seen_at: previous?.first_seen_at ?? now,
    last_seen_at: now,
    request_count: (previous?.request_count ?? 0) + 1,
    methods: [...methods].sort().slice(0, 60),
    permissions: [...permissions].sort(),
    remote_address: normalize(input.remoteAddress, previous?.remote_address ?? ""),
    user_agent: normalize(input.userAgent, previous?.user_agent ?? ""),
    client_name: normalize(input.clientName, previous?.client_name ?? ""),
    last_status: typeof input.status === "number" ? input.status : previous?.last_status,
    last_error: input.error ?? previous?.last_error,
  };
  existing.set(key, next);
  const connections = [...existing.values()]
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, MAX_CONNECTION_RECORDS);
  writeStore({ updated_at: now, connections });
}

export function readMemoryClientConnections(): StoreShape {
  return readStore();
}
