import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const root = process.env.MEMORY_XX_PROJECT_ROOT || "<project-root>";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archiveDir = path.join(root, "logs", "archive-next-residue", stamp);

const patterns = [
  /^wrapper-next\.(log|error\.log|pid)(\..*)?$/u,
  /^qdrant-projector-worker-next\.(log|error\.log|pid)(\..*)?$/u,
  /^fastpath-next\.(log|error\.log|pid)(\..*)?$/u,
];

async function main(): Promise<void> {
  const entries = await fs.readdir(root);
  const files = entries.filter((entry) => patterns.some((pattern) => pattern.test(entry)));
  if (files.length === 0) {
    console.log("No *-next residue logs found.");
    return;
  }
  await fs.mkdir(archiveDir, { recursive: true });
  const moved: string[] = [];
  for (const file of files) {
    const from = path.join(root, file);
    const to = path.join(archiveDir, file);
    if (!fsSync.statSync(from).isFile()) continue;
    await fs.rename(from, to);
    moved.push(to);
  }
  console.log(`Archived ${moved.length} next-residue log files to ${archiveDir}`);
  for (const file of moved) console.log(file);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
