// Self-contained MCP server factory.
// Registers memory tools, handles JSON-RPC dispatch, and provides transport adapters.

import { randomUUID } from "node:crypto";
import { recordMcpToolInvocation } from "../observability/mcp-tool-invocations";
import {
  type JsonRpcMessage,
  type JsonRpcResponse,
  type JsonRpcNotification,
  successResponse,
  errorResponse,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  isJsonRpcNotification,
} from "./protocol";
import { ToolRegistry, ResourceRegistry, type ToolHandler } from "./tool-registry";
import { createLogger } from "../shared/logger";

const log = createLogger("mcp:server");

export interface McpServerCapabilities {
  readonly tools?: { readonly listChanged?: boolean };
  readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpServerOptions {
  readonly serverInfo?: McpServerInfo;
  readonly capabilities?: McpServerCapabilities;
}

const DEFAULT_SERVER_INFO: McpServerInfo = {
  name: "memory-xx-mcp",
  version: "1.0.0",
};

function defaultCodexProjectId(): string {
  return process.env.MEMORY_V2_CODEX_PROJECT_ID?.trim() ||
    process.env.MEMORY_V2_PROJECT_ID?.trim() ||
    "memory-xx";
}

function defaultRecallScopeContext(args: Record<string, unknown>): Record<string, unknown> {
  return {
    user_id: typeof args.user_id === "string" ? args.user_id : "current-instance-owner",
    workspace_id: typeof args.workspace_id === "string" ? args.workspace_id : "current-instance",
    project_ids: Array.isArray(args.project_ids) ? args.project_ids : [defaultCodexProjectId()],
    memory_ids: Array.isArray(args.memory_ids) ? args.memory_ids : undefined,
    include_global: true,
  };
}

function defaultSmartWriteScope(args: Record<string, unknown>): { scope_type: string; scope_id: string; reason: string } {
  const scopeType = typeof args.scope_type === "string" && args.scope_type.trim() !== "" ? args.scope_type : "";
  const scopeId = typeof args.scope_id === "string" && args.scope_id.trim() !== "" ? args.scope_id : "";
  if (scopeType && scopeId) {
    return { scope_type: scopeType, scope_id: scopeId, reason: "caller_supplied" };
  }
  const agentId = typeof args.agent_id === "string" ? args.agent_id : "";
  if (/self[-_ ]?improvement|doctor|ops/i.test(agentId)) {
    return { scope_type: "project", scope_id: "memory-xx-self-improvement", reason: "ops_agent_default" };
  }
  return { scope_type: "project", scope_id: defaultCodexProjectId(), reason: "codex_project_default" };
}

export class McpServer {
  readonly tools: ToolRegistry;
  readonly resources: ResourceRegistry;
  readonly serverInfo: McpServerInfo;
  readonly capabilities: McpServerCapabilities;

  constructor(options?: McpServerOptions) {
    this.tools = new ToolRegistry();
    this.resources = new ResourceRegistry();
    this.serverInfo = options?.serverInfo ?? DEFAULT_SERVER_INFO;
    this.capabilities = options?.capabilities ?? {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    };
  }

  registerTool(name: string, description: string, inputSchema: import("./tool-registry").ToolInputSchema, handler: ToolHandler): void {
    this.tools.register({ name, description, inputSchema }, handler);
  }

  registerResource(uri: string, name: string, handler: () => Promise<{ content: string; mimeType?: string }>, description?: string): void {
    this.resources.register({ uri, name, description }, handler);
  }

  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | JsonRpcNotification | null> {
    const { method, params, id } = message;
    const msgId = id ?? null;

    switch (method) {
      case "initialize":
        return successResponse(msgId, {
          protocolVersion: "2024-11-05",
          capabilities: this.capabilities,
          serverInfo: this.serverInfo,
        });

      case "ping":
        return successResponse(msgId, {});

      case "notifications/initialized":
        // Client confirmation — no response needed for notifications
        return null;

      case "tools/list":
        return successResponse(msgId, { tools: this.tools.list() });

      case "tools/call": {
        const toolName = params?.name as string | undefined;
        if (!toolName) {
          return errorResponse(msgId, INVALID_PARAMS, "Missing tool name");
        }
        const started = Date.now();
        if (!this.tools.has(toolName)) {
          recordMcpToolInvocation({
            toolName,
            success: false,
            latencyMs: Date.now() - started,
            error: `Tool not found: ${toolName}`,
          });
          return errorResponse(msgId, METHOD_NOT_FOUND, `Tool not found: ${toolName}`);
        }
        try {
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          const result = await this.tools.call(toolName, args);
          recordMcpToolInvocation({
            toolName,
            agentId: typeof args.agent_id === "string" ? args.agent_id : undefined,
            success: true,
            latencyMs: Date.now() - started,
          });
          return successResponse(msgId, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          recordMcpToolInvocation({
            toolName,
            success: false,
            latencyMs: Date.now() - started,
            error: errorMessage,
          });
          return successResponse(msgId, {
            content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
            isError: true,
          });
        }
      }

      case "resources/list":
        return successResponse(msgId, { resources: this.resources.list() });

      case "resources/read": {
        const uri = params?.uri as string | undefined;
        if (!uri) {
          return errorResponse(msgId, INVALID_PARAMS, "Missing resource uri");
        }
        try {
          const content = await this.resources.read(uri);
          return successResponse(msgId, {
            contents: [{ uri, mimeType: content.mimeType ?? "text/plain", text: content.content }],
          });
        } catch (err) {
          return errorResponse(msgId, METHOD_NOT_FOUND, err instanceof Error ? err.message : String(err));
        }
      }

      default:
        if (isJsonRpcNotification(message)) {
          return null;
        }
        return errorResponse(msgId, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}

// ─── Tool registration helper ──────────────────────────────────────────────────

export function registerMemoryTools(
  server: McpServer,
  deps: {
    readonly baseUrl: string;
    readonly apiToken?: string;
  }
): void {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) {
    headers["Authorization"] = `Bearer ${deps.apiToken}`;
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async function get(path: string): Promise<unknown> {
    const res = await fetch(`${base}${path}`, { headers, method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Tool: search_memories
  server.registerTool(
    "search_memories",
    "Search memories using natural language query. Returns relevant memory records ranked by relevance.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Maximum results to return (default: 6)" },
        user_id: { type: "string", description: "Filter by user ID" },
        workspace_id: { type: "string", description: "Filter by workspace ID" },
        project_ids: {
          type: "array",
          description: "Filter by project IDs (JSON array string)",
        },
      },
      required: ["query"],
    },
    async (args) => {
      const body: Record<string, unknown> = {
        query: args.query,
        limit: typeof args.limit === "number" ? args.limit : 6,
      };
      const scopeContext: Record<string, unknown> = {};
      if (typeof args.user_id === "string") scopeContext.user_id = args.user_id;
      if (typeof args.workspace_id === "string") scopeContext.workspace_id = args.workspace_id;
      if (Array.isArray(args.project_ids)) scopeContext.project_ids = args.project_ids;
      body.scope_context = Object.keys(scopeContext).length > 0
        ? { ...scopeContext, include_global: true }
        : defaultRecallScopeContext(args);
      return post("/api/memory/v2/recall/query", body);
    }
  );

  // Tool: write_memory
  server.registerTool(
    "write_memory",
    "Write a new memory record. Creates a memory with the specified content and scope.",
    {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content text" },
        scope_type: {
          type: "string",
          description: "Scope type",
          enum: ["personal", "shared", "project", "global"],
        },
        scope_id: { type: "string", description: "Scope identifier" },
        title: { type: "string", description: "Optional memory title" },
        author: { type: "string", description: "Author identifier (default: klee)" },
        tags: { type: "array", description: "Tags for categorization" },
      },
      required: ["content", "scope_type", "scope_id"],
    },
    async (args) => {
      const body: Record<string, unknown> = {
        content: args.content,
        scopeType: args.scope_type,
        scopeId: args.scope_id,
        requestId: randomUUID(),
        actorId: (args.author as string) || "klee",
      };
      if (typeof args.title === "string") body.title = args.title;
      if (Array.isArray(args.tags)) body.metadata = { tags: args.tags };
      return post("/api/memory/v2/write", body);
    }
  );

  // Tool: recall_memory
  server.registerTool(
    "recall_memory",
    "Recall memories using the orchestrator. Provides full recall with scope resolution.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Recall query" },
        user_id: { type: "string", description: "User context" },
        workspace_id: { type: "string", description: "Workspace context" },
        project_ids: { type: "array", description: "Project scope ids" },
        memory_ids: { type: "array", description: "Exact memory record ids to recall" },
        limit: { type: "number", description: "Max results (default: 6)" },
      },
      required: ["query"],
    },
    async (args) => {
      const projectIds = Array.isArray(args.project_ids)
        ? args.project_ids.map(String).map((item) => item.trim()).filter(Boolean)
        : [];
      const memoryIds = Array.isArray(args.memory_ids)
        ? args.memory_ids.map(String).map((item) => item.trim()).filter(Boolean)
        : [];
      const scopeContext = defaultRecallScopeContext(args);
      const body: Record<string, unknown> = {
        query: args.query,
        agent_id: "mcp-agent",
        limit: typeof args.limit === "number" ? args.limit : 6,
        include_knowledge: false,
        user_id: scopeContext.user_id,
        workspace_id: scopeContext.workspace_id,
        include_global: scopeContext.include_global,
        project_ids: projectIds.length > 0 ? projectIds : scopeContext.project_ids,
      };
      if (projectIds.length > 0) {
        body.scope_type = "project";
        body.scope_id = projectIds[0];
      }
      if (memoryIds.length > 0) {
        body.memory_ids = memoryIds;
      }
      return post("/api/memory/v2/unified/recall", body);
    }
  );

  // Tool: smart_write_memory
  server.registerTool(
    "smart_write_memory",
    "Extract canonical memories from user text and optionally write them through memory-xx intelligence.",
    {
      type: "object",
      properties: {
        text: { type: "string", description: "Raw user text or conversation fragment" },
        scope_type: {
          type: "string",
          description: "Target scope type",
          enum: ["personal", "shared", "project", "global", "execution", "task", "user", "workspace", "run"],
        },
        scope_id: { type: "string", description: "Target scope identifier" },
        agent_id: { type: "string", description: "Calling agent identifier" },
        user_id: { type: "string", description: "User context" },
        workspace_id: { type: "string", description: "Workspace context" },
        mode: { type: "string", description: "draft, write, or auto_approve", enum: ["draft", "write", "auto_approve"] },
      },
      required: ["text"],
    },
    async (args) => {
      const defaultedScope = defaultSmartWriteScope(args);
      return post("/api/memory/v2/mcp/smart-write", {
        text: args.text,
        scope_type: defaultedScope.scope_type,
        scope_id: defaultedScope.scope_id,
        agent_id: (args.agent_id as string) || "mcp-agent",
        user_id: args.user_id,
        workspace_id: args.workspace_id,
        codex_scope_default: defaultedScope.reason,
        mode: (args.mode as string) || "write",
      });
    }
  );

  // Tool: list_pending_memories
  server.registerTool(
    "list_pending_memories",
    "List pending memory records awaiting review.",
    {
      type: "object",
      properties: {
        scope_type: { type: "string", description: "Optional scope type filter" },
        scope_id: { type: "string", description: "Optional scope id filter" },
        agent_id: { type: "string", description: "Optional author/agent filter" },
        memory_class: { type: "string", description: "Optional memory policy class filter" },
        recall_policy: { type: "string", description: "Optional recall policy filter" },
        policy_action: { type: "string", description: "Optional policy action filter" },
        source: { type: "string", description: "Optional source metadata filter" },
        limit: { type: "number", description: "Maximum records to return" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
    async (args) => {
      return post("/api/memory/v2/mcp/list-pending", {
        scope_type: args.scope_type,
        scope_id: args.scope_id,
        agent_id: args.agent_id,
        memory_class: args.memory_class,
        recall_policy: args.recall_policy,
        policy_action: args.policy_action,
        source: args.source,
        limit: typeof args.limit === "number" ? args.limit : 20,
        offset: typeof args.offset === "number" ? args.offset : 0,
      });
    }
  );

  // Tool: approve_memory
  server.registerTool(
    "approve_memory",
    "Approve a pending memory record so it becomes recallable.",
    {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Memory record id" },
        reviewer_id: { type: "string", description: "Reviewer identifier" },
        reason: { type: "string", description: "Optional review note" },
      },
      required: ["memory_id"],
    },
    async (args) => {
      return post("/api/memory/v2/mcp/approve", {
        memory_id: args.memory_id,
        reviewer_id: (args.reviewer_id as string) || "mcp-reviewer",
        reason: args.reason,
      });
    }
  );

  // Tool: reject_memory
  server.registerTool(
    "reject_memory",
    "Reject a pending memory record so it remains hidden from default recall.",
    {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Memory record id" },
        reviewer_id: { type: "string", description: "Reviewer identifier" },
        reason: { type: "string", description: "Rejection reason" },
      },
      required: ["memory_id"],
    },
    async (args) => {
      return post("/api/memory/v2/mcp/reject", {
        memory_id: args.memory_id,
        reviewer_id: (args.reviewer_id as string) || "mcp-reviewer",
        reason: (args.reason as string) || "rejected via MCP",
      });
    }
  );

  // Tool: summarize_memories
  server.registerTool(
    "summarize_memories",
    "Search and summarize memories. Returns a condensed summary of relevant memories.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_items: { type: "number", description: "Max items to summarize (default: 3)" },
        user_id: { type: "string", description: "User context" },
      },
      required: ["query"],
    },
    async (args) => {
      return post("/api/memory/v2/orchestrator/summarize-memory", {
        request: {
          query: args.query,
          scope_context: {
            user_id: (args.user_id as string) || "current-instance-owner",
            workspace_id: "current-instance",
            include_global: true,
          },
        },
        max_items: typeof args.max_items === "number" ? args.max_items : 3,
      });
    }
  );

  // Tool: forget_memory
  server.registerTool(
    "forget_memory",
    "Delete or archive a memory by ID. Use mode 'archive' for soft delete or 'tombstone' for permanent marking.",
    {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Memory ID to forget" },
        mode: { type: "string", description: "Delete mode", enum: ["tombstone", "archive"] },
      },
      required: ["memory_id"],
    },
    async (args) => {
      return post("/api/memory/v2/orchestrator/forget-memory", {
        requestId: randomUUID(),
        actorId: "klee",
        memoryId: args.memory_id,
        mode: args.mode === "archive" ? "archive" : "tombstone",
      });
    }
  );

  // Tool: resolve_scope_plan
  server.registerTool(
    "resolve_scope_plan",
    "Resolve which memory scopes are accessible for a given query context.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Query to resolve scopes for" },
        user_id: { type: "string", description: "User context" },
        workspace_id: { type: "string", description: "Workspace context" },
      },
      required: ["query"],
    },
    async (args) => {
      return post("/api/memory/v2/orchestrator/resolve-scope-plan", {
        recall_request: {
          query: args.query,
          scope_context: {
            user_id: (args.user_id as string) || "current-instance-owner",
            workspace_id: (args.workspace_id as string) || "current-instance",
            include_global: true,
          },
        },
      });
    }
  );

  // Tool: audit_memory
  server.registerTool(
    "audit_memory",
    "Audit memory database consistency. Checks for orphaned records, missing events, etc.",
    {
      type: "object",
      properties: {
        include_records: {
          type: "boolean",
          description: "Include full record snapshot (default: false)",
        },
      },
    },
    async (args) => {
      return post("/api/memory/v2/orchestrator/audit-memory-consistency", {
        include_records: args.include_records === true,
      });
    }
  );

  // Tool: repair_memory
  server.registerTool(
    "repair_memory",
    "Repair memory consistency issues found by audit. Supports dry-run mode.",
    {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "Preview repairs without applying (default: true)",
        },
      },
    },
    async (args) => {
      return post("/api/memory/v2/orchestrator/repair-memory-consistency", {
        dry_run: args.dry_run !== false,
      });
    }
  );
}

// ─── Resource registration ──────────────────────────────────────────────────────

export function registerMemoryResources(
  server: McpServer,
  deps: {
    readonly baseUrl: string;
    readonly apiToken?: string;
  }
): void {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (deps.apiToken) {
    headers["Authorization"] = `Bearer ${deps.apiToken}`;
  }

  server.registerResource(
    "memory://health",
    "Memory Service Health",
    async () => {
      const res = await fetch(`${base}/health`, { headers });
      const data = await res.json();
      return { content: JSON.stringify(data, null, 2), mimeType: "application/json" };
    },
    "Current health status of the memory service"
  );

  server.registerResource(
    "memory://metrics",
    "Memory Service Metrics",
    async () => {
      const res = await fetch(`${base}/metrics`, { headers });
      const data = await res.json();
      return { content: JSON.stringify(data, null, 2), mimeType: "application/json" };
    },
    "Request metrics and performance data"
  );
}

// ─── Factory ────────────────────────────────────────────────────────────────────

export function createMcpServer(options?: McpServerOptions): McpServer {
  return new McpServer(options);
}

export function createDefaultMcpServer(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): McpServer {
  const server = createMcpServer();
  registerMemoryTools(server, deps);
  registerMemoryResources(server, deps);
  return server;
}
