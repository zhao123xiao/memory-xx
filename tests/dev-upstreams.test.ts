import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import test from "node:test";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until the child has started listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`health endpoint did not become ready: ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("dev reranker upstream exposes OpenAI-compatible models and rerank endpoints", async () => {
  const port = await freePort();
  const child = spawn("node", ["sidecars/dev-reranker-upstream/dev-reranker-upstream.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMORY_XX_DEV_RERANKER_HOST: "127.0.0.1",
      MEMORY_XX_DEV_RERANKER_PORT: String(port),
      MEMORY_XX_DEV_RERANKER_MODEL: "memory-xx-dev-reranker",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  test.after(async () => stop(child));

  await waitForHealth(`http://127.0.0.1:${port}/health`);

  const models = await fetch(`http://127.0.0.1:${port}/v3/models`);
  assert.equal(models.status, 200);
  const modelsBody = await models.json() as { readonly data: readonly { readonly id: string }[] };
  assert.equal(modelsBody.data[0]?.id, "memory-xx-dev-reranker");

  const rerank = await fetch(`http://127.0.0.1:${port}/v3/rerank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "memory-xx-dev-reranker",
      query: "memory framework uses qdrant",
      documents: ["unrelated coffee note", "memory-xx uses qdrant projection", "short memory note"],
      top_n: 2,
    }),
  });
  assert.equal(rerank.status, 200);
  const body = await rerank.json() as {
    readonly model: string;
    readonly results: readonly { readonly index: number; readonly relevance_score: number; readonly document: { readonly text: string } }[];
  };

  assert.equal(body.model, "memory-xx-dev-reranker");
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0]?.index, 1);
  assert.ok((body.results[0]?.relevance_score ?? 0) >= (body.results[1]?.relevance_score ?? 0));
  assert.equal(body.results[0]?.document.text, "memory-xx uses qdrant projection");
});

test("dev chat upstream returns JSON that mem0 extractor can parse", async () => {
  const port = await freePort();
  const child = spawn("node", ["sidecars/dev-chat-upstream/dev-chat-upstream.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMORY_XX_DEV_CHAT_HOST: "127.0.0.1",
      MEMORY_XX_DEV_CHAT_PORT: String(port),
      MEMORY_XX_DEV_CHAT_MODEL: "memory-xx-dev-chat",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  test.after(async () => stop(child));

  await waitForHealth(`http://127.0.0.1:${port}/health`);

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "memory-xx-dev-chat",
      messages: [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: "TEXT 记住：memory-xx full profile 可以启用可插拔模块。" },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { readonly choices: readonly { readonly message: { readonly content: string } }[] };
  const content = body.choices[0]?.message.content ?? "";
  const parsed = JSON.parse(content) as {
    readonly should_write: boolean;
    readonly memories: readonly { readonly canonical_content: string; readonly memory_type: string }[];
  };

  assert.equal(parsed.should_write, true);
  assert.equal(parsed.memories[0]?.memory_type, "fact");
  assert.match(parsed.memories[0]?.canonical_content ?? "", /memory-xx full profile/u);
});
