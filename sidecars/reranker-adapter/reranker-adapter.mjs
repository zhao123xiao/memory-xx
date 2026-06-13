import http from "node:http";

const host = process.env.MEMORY_XX_RERANKER_ADAPTER_HOST || process.env.RERANKER_ADAPTER_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.MEMORY_XX_RERANKER_ADAPTER_PORT || process.env.RERANKER_ADAPTER_PORT || "8085", 10);
const downstream = (process.env.MEMORY_XX_RERANKER_DOWNSTREAM_URL || process.env.RERANKER_DOWNSTREAM_URL || "http://127.0.0.1:8084/v3/rerank").replace(/\/+$/, "");
const downstreamModels = process.env.MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL || process.env.RERANKER_DOWNSTREAM_MODELS_URL || "http://127.0.0.1:8084/v3/models";
const timeoutMs = Number.parseInt(process.env.MEMORY_XX_RERANKER_ADAPTER_TIMEOUT_MS || process.env.RERANKER_ADAPTER_TIMEOUT_MS || "10000", 10);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function health(res) {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(downstreamModels, { method: "GET" });
    const text = await response.text();
    sendJson(res, response.ok ? 200 : 503, {
      ok: response.ok,
      downstream_ok: response.ok,
      downstream_status: response.status,
      downstream_models_url: downstreamModels,
      elapsed_ms: Date.now() - started,
      sample: text.slice(0, 160)
    });
  } catch (err) {
    sendJson(res, 503, {
      ok: false,
      downstream_ok: false,
      failure_reason: err instanceof Error ? err.message : String(err),
      downstream_models_url: downstreamModels,
      elapsed_ms: Date.now() - started
    });
  }
}

async function rerank(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: "invalid_json", detail: err instanceof Error ? err.message : String(err) });
    return;
  }

  const started = Date.now();
  try {
    const response = await fetchWithTimeout(downstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
    res.end(text);
    console.log(JSON.stringify({ event: "rerank", status: response.status, elapsed_ms: Date.now() - started, documents: Array.isArray(payload?.documents) ? payload.documents.length : null }));
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      error: "downstream_rerank_failed",
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - started
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/health") return void health(res);
  if (req.method === "POST" && (url.pathname === "/rerank" || url.pathname === "/v3/rerank")) return void rerank(req, res);
  sendJson(res, 404, { ok: false, error: "not_found" });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "started", host, port, downstream, downstreamModels }));
});
