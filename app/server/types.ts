import type { CreateMemoryCommand } from "../shared/contracts/write";
import type { JsonObject } from "../shared";

export interface RecallCliArgs {
  action: "recall";
  query: string;
  userId?: string;
  workspaceId?: string;
  projectIds?: string[];
  includeGlobal?: boolean;
  runtime?: { runId?: string; taskId?: string };
  limit?: number;
  offset?: number;
}

export interface WriteCliArgs {
  action: "write";
  scopeType: string;
  scopeId: string;
  content: string;
  title?: string;
  author: string;
  tags?: string[];
  lifecycleStatus?: string;
  reviewState?: string;
}

export interface HttpWriteBody {
  requestId?: string;
  actorId?: string;
  scopeType?: string;
  scopeId?: string;
  content?: string;
  title?: string | null;
  summary?: string | null;
  metadata?: JsonObject | null;
  dedupeKey?: string | null;
  lifecycleStatus?: string;
  reviewState?: string;
  sources?: CreateMemoryCommand["sources"];
  relations?: CreateMemoryCommand["relations"];
}

export type CliArgs = RecallCliArgs | WriteCliArgs;

export type OrchestratorHttpBody = Record<string, unknown>;
