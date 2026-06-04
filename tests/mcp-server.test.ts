import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import { McpServer, registerMemoryTools, registerMemoryResources } from "../app/mcp/mcp-server";
import { resolveMcpApiToken } from "../scripts/start-mcp-server";

describe("McpServer", () => {
  it("responds to initialize", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {},
    });
    assert.ok(resp && "result" in resp, "expected success response");
    const result = resp.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, "2024-11-05");
    assert.ok(result.serverInfo);
    assert.ok(result.capabilities);
  });

  it("responds to ping", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "ping",
      id: 2,
    });
    assert.ok(resp && "result" in resp);
    assert.deepEqual((resp as { result: unknown }).result, {});
  });

  it("returns null for initialized notification", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(resp, null);
  });

  it("lists registered tools", async () => {
    const server = new McpServer();
    server.tools.register(
      { name: "my_tool", description: "desc", inputSchema: { type: "object" } },
      async () => ({ ok: true })
    );
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 3,
    });
    assert.ok(resp && "result" in resp);
    const result = resp.result as { tools: unknown[] };
    assert.equal(result.tools.length, 1);
  });

  it("calls a tool", async () => {
    const server = new McpServer();
    server.tools.register(
      { name: "echo", description: "echo", inputSchema: { type: "object" } },
      async (args) => args
    );
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 4,
      params: { name: "echo", arguments: { msg: "hello" } },
    });
    assert.ok(resp && "result" in resp);
    const result = resp.result as { content: { type: string; text: string }[] };
    assert.equal(result.content[0].type, "text");
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed, { msg: "hello" });
  });

  it("returns error for missing tool name", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 5,
      params: { arguments: {} },
    });
    assert.ok(resp && "error" in resp);
    assert.equal(resp.error.code, -32602);
  });

  it("returns error for unknown tool", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 6,
      params: { name: "nonexistent", arguments: {} },
    });
    assert.ok(resp && "error" in resp);
    assert.equal(resp.error.code, -32601);
  });

  it("handles tool execution error", async () => {
    const server = new McpServer();
    server.tools.register(
      { name: "fail", description: "fails", inputSchema: { type: "object" } },
      async () => { throw new Error("boom"); }
    );
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 7,
      params: { name: "fail", arguments: {} },
    });
    assert.ok(resp && "result" in resp);
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("boom"));
  });

  it("lists registered resources", async () => {
    const server = new McpServer();
    server.resources.register(
      { uri: "test://res", name: "Test Resource" },
      async () => ({ content: "data" })
    );
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "resources/list",
      id: 8,
    });
    assert.ok(resp && "result" in resp);
    const result = resp.result as { resources: unknown[] };
    assert.equal(result.resources.length, 1);
  });

  it("reads a resource", async () => {
    const server = new McpServer();
    server.resources.register(
      { uri: "test://data", name: "Data", mimeType: "text/plain" },
      async () => ({ content: "hello", mimeType: "text/plain" })
    );
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "resources/read",
      id: 9,
      params: { uri: "test://data" },
    });
    assert.ok(resp && "result" in resp);
    const result = resp.result as { contents: { uri: string; text: string; mimeType: string }[] };
    assert.equal(result.contents[0].text, "hello");
  });

  it("returns error for missing resource uri", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "resources/read",
      id: 10,
      params: {},
    });
    assert.ok(resp && "error" in resp);
    assert.equal(resp.error.code, -32602);
  });

  it("returns error for unknown method", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "unknown/method",
      id: 11,
    });
    assert.ok(resp && "error" in resp);
    assert.equal(resp.error.code, -32601);
  });

  it("returns null for unknown notification", async () => {
    const server = new McpServer();
    const resp = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/unknown",
    });
    assert.equal(resp, null);
  });
});

describe("MCP stdio transport", () => {
  it("prefers MEMORY_XX_MCP_TOKEN over legacy API token", () => {
    assert.equal(resolveMcpApiToken({
      MEMORY_XX_MCP_TOKEN: "trusted-agent",
      MEMORY_XX_API_TOKEN: "legacy",
    }), "trusted-agent");
    assert.equal(resolveMcpApiToken({
      MEMORY_XX_API_TOKEN: "legacy",
    }), "legacy");
  });

  it("writes only JSON-RPC protocol messages to stdout", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/start-mcp-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_XX_BASE_URL: "http://127.0.0.1:5100",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`MCP stdio smoke timed out; stdout=${stdout}; stderr=${stderr}`));
      }, 5_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0);
    const firstLine = stdout.trim().split("\n")[0];
    const parsed = JSON.parse(firstLine);
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, 1);
    assert.ok(parsed.result);
  });
});

describe("registerMemoryTools", () => {
  it("registers all expected memory tools", () => {
    const server = new McpServer();
    registerMemoryTools(server, { baseUrl: "http://localhost:5100" });
    const tools = server.tools.list();
    const names = tools.map((t) => t.name);

    assert.ok(names.includes("search_memories"));
    assert.ok(names.includes("write_memory"));
    assert.ok(names.includes("recall_memory"));
    assert.ok(names.includes("summarize_memories"));
    assert.ok(names.includes("forget_memory"));
    assert.ok(names.includes("resolve_scope_plan"));
    assert.ok(names.includes("audit_memory"));
    assert.ok(names.includes("repair_memory"));
    assert.ok(names.includes("smart_write_memory"));
    assert.ok(names.includes("list_pending_memories"));
    assert.ok(names.includes("approve_memory"));
    assert.ok(names.includes("reject_memory"));

    assert.equal(tools.length, 12);
  });

  it("each tool has required fields", () => {
    const server = new McpServer();
    registerMemoryTools(server, { baseUrl: "http://localhost:5100" });
    for (const tool of server.tools.list()) {
      assert.ok(tool.name.length > 0, `tool ${tool.name} has name`);
      assert.ok(tool.description.length > 0, `tool ${tool.name} has description`);
      assert.equal(tool.inputSchema.type, "object", `tool ${tool.name} has object schema`);
    }
  });

  it("routes recall_memory through unified recall with explicit project and memory ids", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const server = new McpServer();
      registerMemoryTools(server, { baseUrl: "http://localhost:5100" });
      await server.tools.call("recall_memory", {
        query: "alpha",
        project_ids: ["project-a", "project-b"],
        memory_ids: ["memory-1"],
        limit: 3,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://localhost:5100/api/memory/xx/unified/recall");
      assert.equal(calls[0].body.scope_type, "project");
      assert.equal(calls[0].body.scope_id, "project-a");
      assert.deepEqual(calls[0].body.project_ids, ["project-a", "project-b"]);
      assert.deepEqual(calls[0].body.memory_ids, ["memory-1"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("registerMemoryResources", () => {
  it("registers health and metrics resources", () => {
    const server = new McpServer();
    registerMemoryResources(server, { baseUrl: "http://localhost:5100" });
    const resources = server.resources.list();
    const uris = resources.map((r) => r.uri);

    assert.ok(uris.includes("memory://health"));
    assert.ok(uris.includes("memory://metrics"));
    assert.equal(resources.length, 2);
  });
});
