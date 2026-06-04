import { processPendingWriteTickets } from "../app/api/intelligence/handlers";
import { activatePendingRuntimeControlsSync, readRuntimeControlNumberSync } from "../app/runtime-control-settings";
import { initRuntime } from "../app/server/runtime";

function runtimePositiveInt(key: string, envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  const envValue = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  const runtimeValue = readRuntimeControlNumberSync(key, envValue);
  return Number.isFinite(runtimeValue) && runtimeValue > 0 ? runtimeValue : envValue;
}

async function main(): Promise<void> {
  activatePendingRuntimeControlsSync([
    "worker.write_ticket.interval_ms",
    "worker.write_ticket.batch_size",
    "worker.write_ticket.lease_ttl_seconds",
  ]);
  await initRuntime();
  const once = process.argv.includes("--once");
  const intervalMs = runtimePositiveInt("worker.write_ticket.interval_ms", "MEMORY_XX_WRITE_TICKET_WORKER_INTERVAL_MS", 1000);
  const workerId = process.env.MEMORY_XX_WORKER_ID?.trim() || `write-ticket-worker-${process.pid}`;
  do {
    const result = await processPendingWriteTickets({
      workerId,
      limit: runtimePositiveInt("worker.write_ticket.batch_size", "MEMORY_XX_WRITE_TICKET_WORKER_BATCH_SIZE", 10),
      leaseTtlSeconds: runtimePositiveInt("worker.write_ticket.lease_ttl_seconds", "MEMORY_XX_WRITE_TICKET_LEASE_TTL_SECONDS", 120)
    });
    process.stdout.write(JSON.stringify({ worker_id: workerId, ...result, at: new Date().toISOString() }) + "\n");
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1000));
  } while (true);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
