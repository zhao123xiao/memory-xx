import "./test-harness/config.js";
import { GovernanceRepository, PostgresWriteDatabase, loadMemoryXXPostgresConfig, withWriteTransaction } from "../app";
import { requireCliPermission } from "../app/server/permissions.js";

function readArg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function parseTtl(raw: string): number {
  const match = raw.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

function parseScope(raw: string): { scopeType: string; scopeId: string } {
  const index = raw.indexOf(":");
  if (index <= 0 || index === raw.length - 1) {
    throw new Error("--scope must look like project:xxx");
  }
  return { scopeType: raw.slice(0, index), scopeId: raw.slice(index + 1) };
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_apply");
  const scope = parseScope(readArg("scope"));
  const actions = readArg("actions").split(",").map((item) => item.trim()).filter(Boolean);
  const reason = readArg("reason");
  if (!reason) throw new Error("--reason is required");
  const actorId = readArg("actor") || "memory-governance";
  const expiresAt = new Date(Date.now() + parseTtl(readArg("ttl") || "24h")).toISOString();
  const database = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  try {
    const freeze = await withWriteTransaction(database, (tx) => new GovernanceRepository().createFreeze(tx, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      actions,
      reason,
      actorId,
      expiresAt,
    }));
    process.stdout.write(JSON.stringify({ ok: true, freeze }, null, 2) + "\n");
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
