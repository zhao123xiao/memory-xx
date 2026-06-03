#!/usr/bin/env tsx
import "./test-harness/config.js";

import { buildApprovalCapacityAdvice } from "./control-panel/approval-capacity.js";

async function main(): Promise<void> {
  const advice = await buildApprovalCapacityAdvice();
  process.stdout.write(`${JSON.stringify({ ok: true, advice }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
