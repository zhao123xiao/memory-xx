import crypto from "node:crypto";
import http from "node:http";

const host = process.env.MEMORY_XX_DEV_EMBEDDING_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.MEMORY_XX_DEV_EMBEDDING_PORT || "5222", 10);
const dims = Math.max(1, Number.parseInt(process.env.MEMORY_XX_DEV_EMBEDDING_DIMS || process.env.EMBEDDING_DIMS || "384", 10));
const defaultModel = process.env.MEMORY_XX_DEV_EMBEDDING_MODEL || "memory-xx-dev-embedding";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0 ? "{}" : Buffer.concat(chunks).toString("utf8");
}

function vectorFor(input) {
  const values = [];
  let counter = 0;
  while (values.length < dims) {
    const digest = crypto.createHash("sha256").update(`${input}\0${counter}`).digest();
    for (let index = 0; index < digest.length && values.length < dims; index += 2) {
      const value = digest.readInt16BE(index) / 32768;
      values.push(Number(value.toFixed(6)));
    }
    counter += 1;
  }
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => Number((value / magnitude).toFixed(6)));
}

function normalizeInput(input) {
  if (Array.isArray(input)) return input.map((item) => typeof item === "string" ? item : JSON.stringify(item));
  if (typeof input === "string") return [input];
  if (input == null) return [""];
  return [JSON.stringify(input)];
}

async function handleEmbeddings(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: "invalid_json", detail: error instanceof Error ? error.message : String(error) });
    return;
  }

  const inputs = normalizeInput(parsed.input);
  const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : defaultModel;
  sendJson(res, 200, {
    object: "list",
    model,
    data: inputs.map((input, index) => ({
      object: "embedding",
      index,
      embedding: vectorFor(input),
    })),
    usage: {
      prompt_tokens: inputs.length,
      total_tokens: inputs.length,
    },
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model: defaultModel, dims, mode: "dev_deterministic" });
    return;
  }
  if (req.method === "POST" && (url.pathname === "/embeddings" || url.pathname === "/v1/embeddings")) {
    void handleEmbeddings(req, res);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "started", service: "memory-xx-dev-embedding-upstream", host, port, dims, model: defaultModel }));
});
