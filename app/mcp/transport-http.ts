// HTTP transport — handles POST /mcp as JSON-RPC endpoint.
// Designed to be wired into the existing http-server.ts router.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../shared/logger";
import {
  type JsonRpcMessage,
  type JsonRpcResponse,
  type JsonRpcNotification,
  parseMessage,
  isJsonRpcNotification,
  errorResponse,
  PARSE_ERROR,
} from "./protocol";

const log = createLogger("mcp:http");

export type HttpMessageHandler = (message: JsonRpcMessage) => Promise<JsonRpcResponse | JsonRpcNotification | null>;
export type McpHttpAuthChecker = (req: IncomingMessage) => Promise<boolean> | boolean;

export interface McpHttpHandlerOptions {
  readonly authorize?: McpHttpAuthChecker;
}

const MAX_BODY = 1_048_576; // 1MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (chunk: Buffer) => {
      len += chunk.length;
      if (len > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function createMcpHttpHandler(onMessage: HttpMessageHandler, options: McpHttpHandlerOptions = {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "请求方法不允许" }));
      return;
    }

    if (options.authorize && !(await options.authorize(req))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      const resp = errorResponse(null, PARSE_ERROR, "Request body too large");
      res.end(JSON.stringify(resp));
      return;
    }

    // Support batch: single object or array of objects
    let messages: JsonRpcMessage[];
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed) as unknown[];
        messages = arr.map((item) => parseMessage(JSON.stringify(item))).filter((m): m is JsonRpcMessage => m !== null);
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(errorResponse(null, PARSE_ERROR, "Invalid JSON batch")));
        return;
      }
    } else {
      const msg = parseMessage(trimmed);
      messages = msg ? [msg] : [];
    }

    if (messages.length === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorResponse(null, PARSE_ERROR, "No valid JSON-RPC messages")));
      return;
    }

    // If batch, return array of responses; if single, return single response
    const isBatch = trimmed.startsWith("[");
    const responses: JsonRpcResponse[] = [];

    for (const message of messages) {
      try {
        const result = await onMessage(message);
        if (result && !isJsonRpcNotification(result)) {
          responses.push(result as JsonRpcResponse);
        }
      } catch (err) {
        const msg = message as { id?: string | number | null };
        if (msg.id !== undefined && msg.id !== null) {
          responses.push(
            errorResponse(msg.id, -32603, err instanceof Error ? err.message : "Internal error")
          );
        }
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    if (isBatch) {
      res.end(JSON.stringify(responses));
    } else if (responses.length > 0) {
      res.end(JSON.stringify(responses[0]));
    } else {
      res.end();
    }

    log.info("MCP HTTP request handled", { messages: messages.length, responses: responses.length });
  };
}
