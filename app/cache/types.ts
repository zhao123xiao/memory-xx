import type { QueryClassification, RecallRequest, RecallResponse, RecallScopeRef } from "../recall/types";
import type { ScopeType } from "../shared";

export interface MemoryRedisConfig {
  readonly url?: string;
  readonly prefix: string;
  readonly connect_timeout_ms: number;
  readonly empty_recall_ttl_seconds: number;
  readonly ttl_seconds: {
    readonly search: number;
    readonly session: number;
    readonly recent: number;
    readonly startup_context: number;
  };
}

export interface CacheOpResult {
  status: "hit" | "miss" | "stored" | "skipped" | "fallback";
  key?: string;
  reason?: string;
}

export class RecallCacheInvalidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecallCacheInvalidationError";
  }
}

export interface RecallCacheAudit {
  search: CacheOpResult;
  session: CacheOpResult;
  recent: CacheOpResult;
  startup_context: CacheOpResult;
}

export interface RecentCacheEntry {
  readonly memory_id: string;
  readonly scope_type: ScopeType;
  readonly scope_id: string;
  readonly title?: string;
  readonly score: number;
  readonly cached_at: string;
}

export interface SessionCacheEntry {
  readonly query: string;
  readonly audit_ref: string;
  readonly result_memory_ids: string[];
  readonly cached_at: string;
}

export interface RecallCacheRuntime {
  getSearch(request: RecallRequest): Promise<{ response: RecallResponse; key: string } | null>;
  setSearch(request: RecallRequest, response: RecallResponse): Promise<CacheOpResult>;
  getStartupContext(request: RecallRequest, classification: QueryClassification): Promise<{ response: RecallResponse; key: string } | null>;
  setStartupContext(request: RecallRequest, classification: QueryClassification, response: RecallResponse): Promise<CacheOpResult>;
  getSession(request: RecallRequest): Promise<{ entry: SessionCacheEntry; key: string } | null>;
  rememberSession(request: RecallRequest, response: RecallResponse): Promise<CacheOpResult>;
  getRecent(scopes: readonly RecallScopeRef[]): Promise<{ entries: readonly RecentCacheEntry[]; key: string } | null>;
  rememberRecent(scopes: readonly RecallScopeRef[], response: RecallResponse): Promise<CacheOpResult>;
  invalidateScopes(scopes: readonly RecallScopeRef[]): Promise<void>;
  getHealthSnapshot(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
