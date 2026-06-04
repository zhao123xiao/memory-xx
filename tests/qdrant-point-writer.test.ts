import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { HttpQdrantPointWriter } from "../app/qdrant-sync/qdrant-point-writer";

function createMockFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return { ok: true, status: 200 } as Response;
  };

  return {
    fetch: mockFetch as typeof fetch,
    get lastCall() {
      return calls.at(-1) ?? null;
    },
    get callCount() {
      return calls.length;
    },
    get calls() {
      return calls;
    },
    reset() {
      calls.length = 0;
    }
  };
}

function createWriter(options: {
  baseUrl?: string;
  collectionName?: string;
  apiKey?: string;
  fetchImpl: typeof fetch;
}) {
  return new HttpQdrantPointWriter({
    base_url: options.baseUrl,
    collection_name: options.collectionName,
    api_key: options.apiKey,
    fetchImpl: options.fetchImpl,
    config: {
      enabled: true,
      base_url: options.baseUrl,
      collection_name: options.collectionName,
      api_key: options.apiKey
    }
  });
}

describe("HttpQdrantPointWriter", () => {
  let mock: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mock = createMockFetch();
  });

  // 1. upsert with empty array is a no-op
  it("upsert with empty array is a no-op (fetch not called)", async () => {
    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: "test-col",
      fetchImpl: mock.fetch
    });
    await writer.upsert([]);
    assert.equal(mock.callCount, 0);
  });

  // 2. delete with empty array is a no-op
  it("delete with empty array is a no-op (fetch not called)", async () => {
    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: "test-col",
      fetchImpl: mock.fetch
    });
    await writer.delete([]);
    assert.equal(mock.callCount, 0);
  });

  // 3. upsert sends PUT request with correct URL and body
  it("upsert sends PUT request with correct URL and body", async () => {
    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: "test-col",
      fetchImpl: mock.fetch
    });

    const points = [{ id: "pt-1", vector: [0.1, 0.2], payload: { tag: "a" } }];
    await writer.upsert(points as any);

    assert.equal(mock.callCount, 1);
    assert.ok(mock.lastCall);
    assert.match(mock.lastCall.url, /\/collections\/test-col\/points\?wait=true$/);
    assert.equal(mock.lastCall.init.method, "PUT");

    const body = JSON.parse(mock.lastCall.init.body as string);
    assert.deepEqual(body.points, points);

    const headers = mock.lastCall.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
  });

  // 4. delete sends POST request with correct URL and body
  it("delete sends POST request with correct URL and body", async () => {
    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: "test-col",
      fetchImpl: mock.fetch
    });

    const ids = ["pt-1", "pt-2"];
    await writer.delete(ids);

    assert.equal(mock.callCount, 1);
    assert.ok(mock.lastCall);
    assert.match(mock.lastCall.url, /\/collections\/test-col\/points\/delete\?wait=true$/);
    assert.equal(mock.lastCall.init.method, "POST");

    const body = JSON.parse(mock.lastCall.init.body as string);
    assert.deepEqual(body.points, ids);
  });

  // 5. throws when baseUrl not configured
  it("throws when baseUrl not configured", async () => {
    const writer = createWriter({
      baseUrl: undefined,
      collectionName: "test-col",
      fetchImpl: mock.fetch
    });

    await assert.rejects(
      () => writer.upsert([{ id: "x" }] as any),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /尚未配置|not configured/u);
        return true;
      }
    );
  });

  // 6. throws when collectionName not configured
  it("throws when collectionName not configured", async () => {
    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: undefined,
      fetchImpl: mock.fetch
    });

    await assert.rejects(
      () => writer.upsert([{ id: "x" }] as any),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /尚未配置|not configured/u);
        return true;
      }
    );
  });

  // 7. includes api-key header when apiKey provided
  it("includes api-key header when apiKey provided", async () => {
    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: "test-col",
      apiKey: "secret-key-123",
      fetchImpl: mock.fetch
    });

    await writer.upsert([{ id: "pt-1" }] as any);

    assert.ok(mock.lastCall);
    const headers = mock.lastCall.init.headers as Record<string, string>;
    assert.equal(headers["api-key"], "secret-key-123");
  });

  // 8. throws on non-ok response status
  it("throws on non-ok response status", async () => {
    const failFetch: typeof fetch = async () => {
      return { ok: false, status: 500 } as Response;
    };

    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: "test-col",
      fetchImpl: failFetch
    });

    await assert.rejects(
      () => writer.upsert([{ id: "pt-1" }] as any),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("500"));
        return true;
      }
    );
  });

  it("throws when qdrant write exceeds timeout budget", async () => {
    const hangingFetch: typeof fetch = async () => new Promise(() => undefined);
    const writer = new HttpQdrantPointWriter({
      base_url: "http://localhost:6333",
      collection_name: "test-col",
      fetchImpl: hangingFetch,
      timeout_ms: 5,
      config: {
        enabled: true,
        base_url: "http://localhost:6333",
        collection_name: "test-col"
      }
    });

    await assert.rejects(
      () => writer.upsert([{ id: "pt-timeout", vector: [0.1], payload: {} }] as any),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "qdrant_write_timeout");
        return true;
      }
    );
  });

  it("creates missing collection with vector dimension from first point and retries upsert", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, text: async () => "" } as Response;
    };
    const writer = createWriter({
      baseUrl: "http://localhost:6333",
      collectionName: "test-col",
      fetchImpl
    });

    await writer.upsert([{ id: "pt-1", vector: [0.1, 0.2, 0.3], payload: { memory_id: "mem-1" } }] as any);

    assert.equal(calls.length, 3);
    assert.match(calls[0]?.url ?? "", /\/collections\/test-col\/points\?wait=true$/u);
    assert.match(calls[1]?.url ?? "", /\/collections\/test-col$/u);
    assert.equal(calls[1]?.init.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      vectors: { size: 3, distance: "Cosine" },
      on_disk_payload: true
    });
    assert.match(calls[2]?.url ?? "", /\/collections\/test-col\/points\?wait=true$/u);
  });
});
