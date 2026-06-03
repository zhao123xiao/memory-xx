#!/usr/bin/env node
// Standalone MCP server entry point — runs as stdio transport.
// Usage: node --import tsx scripts/start-mcp-server.ts
// Or add to Claude Desktop / Cursor config as a command.

import { createDefaultMcpServer, startStdioTransport } from "../app/mcp";

process.env.MEMORY_V2_LOG_TARGET = process.env.MEMORY_V2_LOG_TARGET || "stderr";

export function resolveMcpApiToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMORY_V2_MCP_TOKEN?.trim() || env.MEMORY_V2_API_TOKEN?.trim() || "";
}

export async function main(): Promise<void> {
  const baseUrl = process.env.MEMORY_V2_BASE_URL ?? process.env.MEMORY_V2_WRAPPER_URL ?? "http://127.0.0.1:5100";
  const apiToken = resolveMcpApiToken();

  const server = createDefaultMcpServer({
    baseUrl,
    apiToken: apiToken || undefined,
  });

  console.error(`[mcp-server] Starting stdio transport, backend: ${baseUrl}`);
  startStdioTransport((msg) => server.handleMessage(msg));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
