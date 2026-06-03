/**
 * Simple load test for memory-xx HTTP server.
 * Usage: MEMORY_V2_API_TOKEN=xxx node --import tsx scripts/load-test.ts
 * Options:
 *   --url=http://localhost:5100   Server base URL
 *   --concurrency=10              Parallel connections
 *   --total=100                   Total requests to send
 *   --write-ratio=0.5             Fraction of requests that are writes (vs recall)
 */

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const baseUrl = getArg("url", process.env.MEMORY_V2_WRAPPER_URL ?? "http://localhost:5100");
const concurrency = parseInt(getArg("concurrency", "10"), 10);
const totalReqs = parseInt(getArg("total", "100"), 10);
const writeRatio = parseFloat(getArg("write-ratio", "0.5"));
const apiToken = process.env.MEMORY_V2_API_TOKEN ?? "";

if (!apiToken) {
  console.error("Set MEMORY_V2_API_TOKEN env var before running");
  process.exit(1);
}

interface Result {
  status: number;
  durationMs: number;
  type: "write" | "recall";
  error?: string;
}

async function sendWrite(): Promise<Result> {
  const start = Date.now();
  try {
    const resp = await fetch(`${baseUrl}/api/memory/v2/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        scopeType: "personal",
        scopeId: "load-test-user",
        content: `Load test entry ${start} — ${Math.random().toString(36).slice(2)}`,
        title: `Load Test ${start}`,
      }),
    });
    return { status: resp.status, durationMs: Date.now() - start, type: "write" };
  } catch (err) {
    return { status: 0, durationMs: Date.now() - start, type: "write", error: String(err) };
  }
}

async function sendRecall(): Promise<Result> {
  const start = Date.now();
  try {
    const resp = await fetch(`${baseUrl}/api/memory/v2/recall/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        query: "load test memories",
        scope_context: { user_id: "load-test-user", workspace_id: "load-test-ws" },
        limit: 5,
      }),
    });
    return { status: resp.status, durationMs: Date.now() - start, type: "recall" };
  } catch (err) {
    return { status: 0, durationMs: Date.now() - start, type: "recall", error: String(err) };
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  console.log(`Load test: ${totalReqs} requests, ${concurrency} concurrency, write ratio ${writeRatio}`);
  console.log(`Target: ${baseUrl}\n`);

  const results: Result[] = [];
  let submitted = 0;

  async function worker(): Promise<void> {
    while (submitted < totalReqs) {
      const isWrite = Math.random() < writeRatio;
      const result = isWrite ? await sendWrite() : await sendRecall();
      results.push(result);
      submitted++;
      if (results.length % 20 === 0) {
        process.stdout.write(`  ${results.length}/${totalReqs}\r`);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const writes = results.filter((r) => r.type === "write");
  const recalls = results.filter((r) => r.type === "recall");
  const errors = results.filter((r) => r.error || r.status >= 400);
  const totalDuration = durations.reduce((a, b) => a + b, 0);

  console.log(`\n=== Results ===`);
  console.log(`Total requests:  ${results.length}`);
  console.log(`  Writes:        ${writes.length}`);
  console.log(`  Recalls:       ${recalls.length}`);
  console.log(`  Errors:        ${errors.length}`);
  console.log(`Total time:      ${totalDuration}ms`);
  console.log(`QPS:             ${((results.length / totalDuration) * 1000).toFixed(1)}`);
  console.log(`\n=== Latency (ms) ===`);
  console.log(`  Min:    ${durations[0]}`);
  console.log(`  P50:    ${percentile(durations, 50)}`);
  console.log(`  P95:    ${percentile(durations, 95)}`);
  console.log(`  P99:    ${percentile(durations, 99)}`);
  console.log(`  Max:    ${durations[durations.length - 1]}`);

  if (errors.length > 0) {
    console.log(`\n=== Error samples ===`);
    for (const e of errors.slice(0, 5)) {
      console.log(`  [${e.type}] status=${e.status} ${e.error ?? ""}`);
    }
  }
}

main().catch(console.error);
