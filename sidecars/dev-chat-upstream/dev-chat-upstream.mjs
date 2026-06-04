import http from "node:http";

const host = process.env.MEMORY_XX_DEV_CHAT_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.MEMORY_XX_DEV_CHAT_PORT || "5223", 10);
const model = process.env.MEMORY_XX_DEV_CHAT_MODEL || "memory-xx-dev-chat";

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

function messagesText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((message) => {
    if (!message || typeof message !== "object") return "";
    return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
  }).join("\n");
}

function cleanMemoryText(text) {
  const match = /TEXT(?:\s+|=)(.+)$/su.exec(text);
  const raw = match?.[1] ?? text;
  return raw
    .replace(/^(?:请)?(?:记住|记一下|帮我记一下)[：:\s]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function classify(text) {
  if (/必须|应该|不能|\bmust\b|\bshould\b|\bnever\b/iu.test(text)) return "constraint";
  if (/决定|决策|\bdecision\b|\bdecided\b/iu.test(text)) return "decision";
  if (/流程|步骤|\bprocedure\b|\bstep\b/iu.test(text)) return "procedure";
  if (/偏好|喜欢|\bprefer\b/iu.test(text)) return "preference";
  return "fact";
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: "invalid_json", detail: error instanceof Error ? error.message : String(error) });
    return;
  }

  const input = messagesText(payload.messages);
  const canonical = cleanMemoryText(input);
  const shouldWrite = canonical.length > 0 && !/[？?]\s*$/u.test(canonical);
  const memoryType = classify(canonical);
  const extraction = {
    should_write: shouldWrite,
    confidence: shouldWrite ? 0.88 : 0.96,
    strategy: "dev_chat",
    operation: shouldWrite ? "add" : "no_change",
    quality_flags: shouldWrite ? ["dev_deterministic"] : ["no_durable_memory"],
    memories: shouldWrite ? [{
      canonical_content: canonical,
      memory_type: memoryType,
      topic: "dev-smoke",
      title: canonical.slice(0, 80),
      confidence: 0.88,
      operation: "add",
    }] : [],
  };

  sendJson(res, 200, {
    id: `chatcmpl-dev-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: JSON.stringify(extraction) },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: input.length,
      completion_tokens: JSON.stringify(extraction).length,
      total_tokens: input.length + JSON.stringify(extraction).length,
    },
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model, mode: "dev_deterministic" });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
    sendJson(res, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "memory-xx" }] });
    return;
  }
  if (req.method === "POST" && (url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions")) {
    void handleChat(req, res);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "started", service: "memory-xx-dev-chat-upstream", host, port, model }));
});
