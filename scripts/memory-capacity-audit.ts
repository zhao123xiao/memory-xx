import "./test-harness/config.js";
import { runCapacityAudit } from "../src/governance/capacity-audit";
import { requireCliPermission } from "../app/server/permissions.js";

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_read");
  const result = await runCapacityAudit();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
