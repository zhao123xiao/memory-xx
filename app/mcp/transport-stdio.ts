// stdio transport — reads JSON-RPC from stdin, writes responses to stdout.
// Framing: one JSON object per line (newline-delimited JSON).

import { createInterface } from "node:readline";
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

const log = createLogger("mcp:stdio");

export type MessageHandler = (message: JsonRpcMessage) => Promise<JsonRpcResponse | JsonRpcNotification | null>;

export function startStdioTransport(onMessage: MessageHandler): void {
  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const message = parseMessage(trimmed);
    if (!message) {
      const resp = errorResponse(null, PARSE_ERROR, "Parse error");
      process.stdout.write(JSON.stringify(resp) + "\n");
      return;
    }

    try {
      const result = await onMessage(message);
      if (result && !isJsonRpcNotification(result)) {
        process.stdout.write(JSON.stringify(result) + "\n");
      }
    } catch (err) {
      log.error("Unhandled message error", { error: String(err) });
      const msg = message as { id?: string | number | null };
      if (msg.id !== undefined && msg.id !== null) {
        const resp = errorResponse(
          msg.id,
          -32603,
          err instanceof Error ? err.message : "Internal error"
        );
        process.stdout.write(JSON.stringify(resp) + "\n");
      }
    }
  });

  rl.on("close", () => {
    log.info("stdin closed, exiting");
    process.exit(0);
  });

  log.info("stdio transport ready");
}
