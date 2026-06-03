#!/usr/bin/env tsx
import { generateReport, formatReport } from "./generate-report.js";
import { requireCliPermission } from "../app/server/permissions.js";

export function readIntervalSeconds(argv: readonly string[] = process.argv): number {
  const raw = argv.find((item) => item.startsWith("--interval="))?.slice("--interval=".length);
  const parsed = raw ? Number(raw) : 60;
  return Number.isFinite(parsed) ? Math.max(10, Math.floor(parsed)) : 60;
}

async function render(useJson: boolean): Promise<void> {
  const report = await generateReport();
  if (useJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(formatReport(report) + "\n");
  process.stdout.write(`\nrefresh: ${readIntervalSeconds()}s; Ctrl+C to exit\n`);
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_read");
  const intervalSeconds = readIntervalSeconds();
  const useJson = process.argv.includes("--json");
  const once = process.argv.includes("--once") || useJson;
  await render(useJson);
  if (once) return;
  const timer = setInterval(() => {
    render(false).catch((error) => {
      process.stderr.write(`dashboard refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, intervalSeconds * 1000);
  timer.unref();
  await new Promise(() => undefined);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
