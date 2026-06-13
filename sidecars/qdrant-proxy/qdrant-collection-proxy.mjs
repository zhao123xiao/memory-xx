import http from "node:http";

const host = process.env.MEMORY_XX_QDRANT_PROXY_HOST || process.env.QDRANT_PROXY_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.MEMORY_XX_QDRANT_PROXY_PORT || process.env.QDRANT_PROXY_PORT || "6334", 10);
const upstream = (process.env.MEMORY_XX_QDRANT_PROXY_UPSTREAM || process.env.QDRANT_PROXY_UPSTREAM || "http://127.0.0.1:6333").replace(/\/+$/, "");
const fromCollection = process.env.MEMORY_XX_QDRANT_PROXY_FROM_COLLECTION || process.env.QDRANT_PROXY_FROM_COLLECTION || "memory-xx";
const toCollection = process.env.MEMORY_XX_QDRANT_PROXY_TO_COLLECTION || process.env.QDRANT_PROXY_TO_COLLECTION || "memory-xx-active";
const timeoutMs = Number.parseInt(process.env.MEMORY_XX_QDRANT_PROXY_TIMEOUT_MS || process.env.QDRANT_PROXY_TIMEOUT_MS || "30000", 10);

function rewritePath(path) {
  const encodedFrom = encodeURIComponent(fromCollection);
  const encodedTo = encodeURIComponent(toCollection);
  return path.replace(`/collections/${encodedFrom}/`, `/collections/${encodedTo}/`).replace(`/collections/${fromCollection}/`, `/collections/${toCollection}/`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function proxy(req, res) {
  const started = Date.now();
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  const rewritten = rewritePath(`${requestUrl.pathname}${requestUrl.search}`);
  const target = `${upstream}${rewritten}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = await readBody(req);
    const headers = { ...req.headers };
    delete headers.host;
    const response = await fetch(target, { method: req.method, headers, body, signal: controller.signal });
    const responseBody = Buffer.from(await response.arrayBuffer());
    const responseHeaders = Object.fromEntries(response.headers.entries());
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
    delete responseHeaders["transfer-encoding"];
    res.writeHead(response.status, responseHeaders);
    res.end(responseBody);
    console.log(JSON.stringify({ event: "proxy", method: req.method, status: response.status, path: requestUrl.pathname, rewritten, elapsed_ms: Date.now() - started }));
  } catch (err) {
    sendJson(res, 502, { error: "qdrant_proxy_failed", detail: err instanceof Error ? err.message : String(err), elapsed_ms: Date.now() - started });
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    sendJson(res, 200, { ok: true, upstream, from_collection: fromCollection, to_collection: toCollection });
    return;
  }
  void proxy(req, res);
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "started", host, port, upstream, from_collection: fromCollection, to_collection: toCollection }));
});
