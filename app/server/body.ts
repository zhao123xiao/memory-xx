import type { IncomingMessage } from "node:http";

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export function parseJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
  timeoutMs = 2_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (req.headers["content-length"] === "0") {
      resolve({});
      return;
    }

    let body = "";
    let received = 0;
    let settled = false;
    let tooLarge = false;
    let timer: NodeJS.Timeout | null = null;

    const clearTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const resolveOnce = (value: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      resolve(value);
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      reject(error);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => rejectOnce(new Error("body_read_timeout")), timeoutMs);
    }

    req.on("data", (chunk: Buffer | string) => {
      if (tooLarge) {
        return;
      }
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      received += Buffer.byteLength(text);
      if (received > maxBytes) {
        tooLarge = true;
        rejectOnce(new Error("body_too_large"));
        return;
      }
      body += text;
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      if (!body.trim()) {
        resolveOnce({});
        return;
      }
      try {
        resolveOnce(JSON.parse(body));
      } catch {
        rejectOnce(new Error("invalid_json_body"));
      }
    });

    req.on("error", (error) => rejectOnce(error));
  });
}
