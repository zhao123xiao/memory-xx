import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const host = process.env.EMBEDDING_PROXY_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_PORT || process.env.EMBEDDING_PROXY_PORT || "5221", 10);
const upstreamBase = (process.env.MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_BASE || process.env.EMBEDDING_PROXY_UPSTREAM_BASE || process.env.EMBEDDING_API_BASE || "").replace(/\/+$/, "");
const upstreamModel = (process.env.MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_MODEL || process.env.EMBEDDING_PROXY_UPSTREAM_MODEL || "").trim();
const upstreamKeyFile = process.env.MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_API_KEY_FILE || process.env.EMBEDDING_PROXY_UPSTREAM_API_KEY_FILE || "";
function loadUpstreamKey() {
  if (process.env.MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_API_KEY) return process.env.MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_API_KEY;
  if (process.env.EMBEDDING_PROXY_UPSTREAM_API_KEY) return process.env.EMBEDDING_PROXY_UPSTREAM_API_KEY;
  if (upstreamKeyFile) {
    try {
      return fs.readFileSync(upstreamKeyFile, "utf8").trim();
    } catch (err) {
      console.error(JSON.stringify({
        event: "upstream_api_key_file_read_failed",
        path: upstreamKeyFile,
        detail: err instanceof Error ? err.message : String(err)
      }));
      return "";
    }
  }
  return process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_KEY || "";
}
const upstreamKey = loadUpstreamKey();
const timeoutMs = Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_TIMEOUT_MS || process.env.EMBEDDING_PROXY_TIMEOUT_MS || "20000", 10);
const maxRetries = Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_MAX_RETRIES || process.env.EMBEDDING_PROXY_MAX_RETRIES || "2", 10);
const maxConcurrency = Math.max(1, Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_MAX_CONCURRENCY || process.env.EMBEDDING_PROXY_MAX_CONCURRENCY || "1", 10));
const minIntervalMs = Math.max(0, Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_MIN_INTERVAL_MS || process.env.EMBEDDING_PROXY_MIN_INTERVAL_MS || "300", 10));
const maxAdaptiveIntervalMs = Math.max(minIntervalMs, Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_MAX_ADAPTIVE_INTERVAL_MS || process.env.EMBEDDING_PROXY_MAX_ADAPTIVE_INTERVAL_MS || "5000", 10));
const cacheTtlMs = Math.max(0, Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_CACHE_TTL_MS || process.env.EMBEDDING_PROXY_CACHE_TTL_MS || "1800000", 10));
const maxCacheEntries = Math.max(1, Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_MAX_CACHE_ENTRIES || process.env.EMBEDDING_PROXY_MAX_CACHE_ENTRIES || "1000", 10));
const rateLimitCooldownMs = Math.max(0, Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_RATE_LIMIT_COOLDOWN_MS || process.env.EMBEDDING_PROXY_RATE_LIMIT_COOLDOWN_MS || "10000", 10));
const maxQueueWaitMs = Math.max(0, Number.parseInt(process.env.MEMORY_XX_EMBEDDING_PROXY_MAX_QUEUE_WAIT_MS || process.env.EMBEDDING_PROXY_MAX_QUEUE_WAIT_MS || "6000", 10));

const cache = new Map();
const inflight = new Map();
const queue = [];
let active = 0;
let lastStart = 0;
let rateLimitedUntil = 0;
let adaptiveIntervalMs = minIntervalMs;
let consecutiveRateLimits = 0;
const recentEvents = [];
const stats = {
  requests: 0,
  cache_hits: 0,
  cache_misses: 0,
  inflight_hits: 0,
  stores: 0,
  upstream_200: 0,
  upstream_429: 0,
  upstream_503: 0,
  upstream_other_error: 0,
  upstream_failures: 0,
  queue_rejected: 0,
  latency_ms: [],
  queue_wait_ms: []
};

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
  return chunks.length === 0 ? "{}" : Buffer.concat(chunks).toString("utf8");
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedPush(values, value, maxSize = 200) {
  values.push(value);
  while (values.length > maxSize) values.shift();
}

function recordEvent(status, latencyMs) {
  recentEvents.push({ at: Date.now(), status, latency_ms: latencyMs });
  while (
    recentEvents.length > 500 ||
    (recentEvents[0] && recentEvents[0].at < Date.now() - 60 * 60 * 1000)
  ) {
    recentEvents.shift();
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function recentCount(status, windowMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  return recentEvents.filter((event) => event.status === status && event.at >= cutoff).length;
}

function retryAfterMs(response, fallbackMs) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return fallbackMs;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(60_000, Math.round(seconds * 1000));
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs) && dateMs > Date.now()) return Math.min(60_000, dateMs - Date.now());
  return fallbackMs;
}

function jitter(ms) {
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

function cacheKey(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function upstreamRequestBody(body) {
  if (!upstreamModel) return body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    return JSON.stringify({ ...parsed, model: upstreamModel });
  } catch {
    return body;
  }
}

function readCache(key) {
  if (cacheTtlMs <= 0) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.response;
}

function writeCache(key, response) {
  if (cacheTtlMs <= 0 || response.status !== 200) return;
  stats.stores += 1;
  cache.set(key, { response, expiresAt: Date.now() + cacheTtlMs });
  while (cache.size > maxCacheEntries) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject, queuedAt: Date.now() });
    drainQueue();
  });
}

function drainQueue() {
  if (active >= maxConcurrency || queue.length === 0) return;
  const item = queue.shift();
  const waitMs = Math.max(0, adaptiveIntervalMs - (Date.now() - lastStart));
  setTimeout(async () => {
    const queueWaitMs = Date.now() - item.queuedAt;
    boundedPush(stats.queue_wait_ms, queueWaitMs);
    if (maxQueueWaitMs > 0 && queueWaitMs > maxQueueWaitMs) {
      stats.queue_rejected += 1;
      item.resolve({
        status: 503,
        contentType: "application/json",
        text: JSON.stringify({
          error: "embedding_proxy_queue_budget_exceeded",
          queue_wait_ms: queueWaitMs,
          queue_depth: queue.length
        })
      });
      drainQueue();
      return;
    }
    active += 1;
    lastStart = Date.now();
    try {
      item.resolve(await item.task());
    } catch (err) {
      item.reject(err);
    } finally {
      active -= 1;
      drainQueue();
    }
  }, waitMs);
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(30_000, Math.round(seconds * 1000));
  }
  return Math.min(10_000, 500 * attempt * attempt);
}

async function fetchEmbedding(body, started) {
  if (rateLimitedUntil > Date.now()) {
    stats.upstream_503 += 1;
    return {
      status: 503,
      contentType: "application/json",
      text: JSON.stringify({
        error: "upstream_embedding_rate_limited",
        retry_after_ms: rateLimitedUntil - Date.now(),
        elapsed_ms: Date.now() - started
      })
    };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const response = await fetchWithTimeout(`${upstreamBase}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstreamKey}`
        },
        body: upstreamRequestBody(body)
      });
      const text = await response.text();
      const elapsedMs = Date.now() - started;
      boundedPush(stats.latency_ms, elapsedMs);
      recordEvent(response.status, elapsedMs);
      if (response.status === 200) {
        stats.upstream_200 += 1;
        consecutiveRateLimits = 0;
        if (adaptiveIntervalMs > minIntervalMs) {
          adaptiveIntervalMs = Math.max(minIntervalMs, Math.floor(adaptiveIntervalMs * 0.9));
        }
      } else if (response.status === 429) {
        stats.upstream_429 += 1;
      } else if (response.status === 503) {
        stats.upstream_503 += 1;
      } else if (response.status >= 400) {
        stats.upstream_other_error += 1;
      }
      console.log(JSON.stringify({ event: "embedding", status: response.status, attempt, elapsed_ms: elapsedMs, queue_depth: queue.length, adaptive_interval_ms: adaptiveIntervalMs }));
      if (response.status === 429) {
        consecutiveRateLimits += 1;
        const backoffMs = jitter(Math.max(rateLimitCooldownMs, retryAfterMs(response, rateLimitCooldownMs)) * Math.max(1, consecutiveRateLimits));
        adaptiveIntervalMs = Math.min(maxAdaptiveIntervalMs, Math.max(adaptiveIntervalMs * 2, minIntervalMs + 250));
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + backoffMs);
        return {
          status: 503,
          contentType: "application/json",
          text: JSON.stringify({
            error: "upstream_embedding_rate_limited",
            upstream_status: 429,
            retry_after_ms: rateLimitedUntil - Date.now(),
            elapsed_ms: Date.now() - started
          })
        };
      }
      if (response.status >= 500 && attempt <= maxRetries) {
        stats.upstream_failures += 1;
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      return { status: response.status, contentType: response.headers.get("content-type") || "application/json", text };
    } catch (err) {
      lastError = err;
      stats.upstream_failures += 1;
      if (attempt <= maxRetries) await sleep(500 * attempt * attempt);
    }
  }

  return {
    status: 502,
    contentType: "application/json",
    text: JSON.stringify({
      error: "upstream_embedding_failed",
      detail: lastError instanceof Error ? lastError.message : String(lastError),
      elapsed_ms: Date.now() - started
    })
  };
}

async function proxyEmbeddings(req, res) {
  stats.requests += 1;
  if (!upstreamBase || !upstreamKey) {
    sendJson(res, 503, { error: "embedding_proxy_not_configured" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: "read_body_failed", detail: err instanceof Error ? err.message : String(err) });
    return;
  }

  const started = Date.now();
  const key = cacheKey(body);
  const cached = readCache(key);
  if (cached) {
    stats.cache_hits += 1;
    res.writeHead(cached.status, { "content-type": cached.contentType, "x-embedding-proxy-cache": "hit" });
    res.end(cached.text);
    console.log(JSON.stringify({ event: "embedding_cache_hit", status: cached.status, elapsed_ms: Date.now() - started }));
    return;
  }
  stats.cache_misses += 1;

  let task = inflight.get(key);
  if (!task) {
    task = schedule(() => fetchEmbedding(body, started));
    inflight.set(key, task);
    task.finally(() => inflight.delete(key));
  } else {
    stats.inflight_hits += 1;
  }
  const response = await task;
  writeCache(key, response);
  res.writeHead(response.status, { "content-type": response.contentType, "x-embedding-proxy-cache": "miss" });
  res.end(response.text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, upstreamBase && upstreamKey ? 200 : 503, {
      ok: Boolean(upstreamBase && upstreamKey),
      upstream_configured: Boolean(upstreamBase),
      upstream_model_override: upstreamModel || null,
      api_key_configured: Boolean(upstreamKey),
      timeout_ms: timeoutMs,
      max_retries: maxRetries,
      max_concurrency: maxConcurrency,
      min_interval_ms: minIntervalMs,
      adaptive_interval_ms: adaptiveIntervalMs,
      max_adaptive_interval_ms: maxAdaptiveIntervalMs,
      max_queue_wait_ms: maxQueueWaitMs,
      cache_ttl_ms: cacheTtlMs,
      cache_entries: cache.size,
      inflight: inflight.size,
      queue_depth: queue.length,
      rate_limited_until: rateLimitedUntil > Date.now() ? new Date(rateLimitedUntil).toISOString() : null,
      cooldown_until: rateLimitedUntil > Date.now() ? new Date(rateLimitedUntil).toISOString() : null,
      recent_429_15m: recentCount(429),
      recent_503_15m: recentCount(503),
      upstream_latency_ms: {
        p50: percentile(stats.latency_ms, 50),
        p95: percentile(stats.latency_ms, 95),
        p99: percentile(stats.latency_ms, 99)
      },
      queue_wait_ms: {
        p50: percentile(stats.queue_wait_ms, 50),
        p95: percentile(stats.queue_wait_ms, 95),
        p99: percentile(stats.queue_wait_ms, 99)
      },
      cache_hit_rate: stats.cache_hits + stats.cache_misses > 0
        ? stats.cache_hits / (stats.cache_hits + stats.cache_misses)
        : null,
      stats: {
        ...stats,
        latency_ms: undefined,
        queue_wait_ms: undefined
      }
    });
    return;
  }
  if (req.method === "POST" && (url.pathname === "/embeddings" || url.pathname === "/v1/embeddings")) {
    void proxyEmbeddings(req, res);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "started", host, port, upstream_configured: Boolean(upstreamBase) }));
});
