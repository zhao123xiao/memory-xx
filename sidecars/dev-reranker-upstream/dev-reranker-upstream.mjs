import http from "node:http";

const host = process.env.MEMORY_XX_DEV_RERANKER_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.MEMORY_XX_DEV_RERANKER_PORT || "8084", 10);
const model = process.env.MEMORY_XX_DEV_RERANKER_MODEL || "memory-xx-dev-reranker";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenize(value) {
  return new Set(String(value).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function score(query, document) {
  const queryTokens = tokenize(query);
  const documentTokens = tokenize(document);
  if (queryTokens.size === 0 || documentTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) overlap += 1;
  }
  return Number((overlap / Math.sqrt(queryTokens.size * documentTokens.size)).toFixed(6));
}

function documentText(document) {
  if (typeof document === "string") return document;
  if (document && typeof document === "object") {
    const record = document;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return JSON.stringify(document ?? "");
}

async function handleRerank(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: "invalid_json", detail: error instanceof Error ? error.message : String(error) });
    return;
  }

  const query = typeof payload.query === "string" ? payload.query : "";
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const topN = Number.isFinite(payload.top_n) && payload.top_n > 0 ? Number(payload.top_n) : documents.length;
  const ranked = documents
    .map((document, index) => {
      const text = documentText(document);
      return {
        index,
        relevance_score: score(query, text),
        document: typeof document === "string" ? { text } : document,
      };
    })
    .sort((left, right) => right.relevance_score - left.relevance_score || left.index - right.index)
    .slice(0, topN);

  sendJson(res, 200, {
    object: "list",
    model: typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : model,
    results: ranked,
    usage: {
      prompt_tokens: query.length,
      total_tokens: query.length + documents.length,
    },
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model, mode: "dev_deterministic" });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v3/models" || url.pathname === "/v1/models")) {
    sendJson(res, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "memory-xx" }] });
    return;
  }
  if (req.method === "POST" && (url.pathname === "/rerank" || url.pathname === "/v3/rerank" || url.pathname === "/v1/rerank")) {
    void handleRerank(req, res);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "started", service: "memory-xx-dev-reranker-upstream", host, port, model }));
});
