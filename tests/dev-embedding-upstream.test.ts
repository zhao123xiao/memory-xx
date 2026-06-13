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

test("dev embedding upstream returns deterministic OpenAI-compatible embeddings", async () => {
  const port = await freePort();
  const child = spawn("node", ["sidecars/dev-embedding-upstream/dev-embedding-upstream.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMORY_XX_DEV_EMBEDDING_HOST: "127.0.0.1",
      MEMORY_XX_DEV_EMBEDDING_PORT: String(port),
      MEMORY_XX_DEV_EMBEDDING_DIMS: "8",
      MEMORY_XX_DEV_EMBEDDING_MODEL: "memory-xx-dev-embedding",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  test.after(async () => stop(child));

  await waitForHealth(`http://127.0.0.1:${port}/health`);

  const first = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "memory-xx-dev-embedding", input: ["alpha", "alpha", "beta"] }),
  });

  assert.equal(first.status, 200);
  const body = await first.json() as {
    readonly object: string;
    readonly model: string;
    readonly data: readonly { readonly object: string; readonly index: number; readonly embedding: readonly number[] }[];
    readonly usage: { readonly prompt_tokens: number; readonly total_tokens: number };
  };

  assert.equal(body.object, "list");
  assert.equal(body.model, "memory-xx-dev-embedding");
  assert.equal(body.data.length, 3);
  assert.equal(body.data[0]?.object, "embedding");
  assert.equal(body.data[0]?.index, 0);
  assert.equal(body.data[0]?.embedding.length, 8);
  assert.deepEqual(body.data[0]?.embedding, body.data[1]?.embedding);
  assert.notDeepEqual(body.data[0]?.embedding, body.data[2]?.embedding);
  assert.equal(body.usage.prompt_tokens, 3);
  assert.equal(body.usage.total_tokens, 3);
});
