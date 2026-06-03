import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export type RuntimeArtifactKind = "projector_status_tmp" | "env_backup";

export interface RuntimeArtifact {
  readonly path: string;
  readonly name: string;
  readonly kind: RuntimeArtifactKind;
  readonly size_bytes: number;
  readonly mtime_ms: number;
}

export interface RuntimeArtifactScan {
  readonly root_dir: string;
  readonly files: readonly RuntimeArtifact[];
}

export interface RuntimeArtifactCleanupResult extends RuntimeArtifactScan {
  readonly apply: boolean;
  readonly archive_dir: string;
  readonly deleted: readonly string[];
  readonly archived: readonly string[];
}

const PROJECTOR_TMP_PATTERN = /^qdrant-projector-worker\.status\.json\..+\.tmp$/u;
const ENV_BACKUP_PATTERN = /^\.env\.bak.+/u;

export async function scanRuntimeArtifacts(options: {
  readonly rootDir: string;
}): Promise<RuntimeArtifactScan> {
  const rootDir = path.resolve(options.rootDir);
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: RuntimeArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const kind = classifyArtifact(entry.name);
    if (!kind) continue;
    const fullPath = path.join(rootDir, entry.name);
    const fileStat = await stat(fullPath);
    files.push({
      path: fullPath,
      name: entry.name,
      kind,
      size_bytes: fileStat.size,
      mtime_ms: fileStat.mtimeMs
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { root_dir: rootDir, files };
}

export async function cleanupRuntimeArtifacts(options: {
  readonly rootDir: string;
  readonly archiveDir?: string;
  readonly apply: boolean;
}): Promise<RuntimeArtifactCleanupResult> {
  const scan = await scanRuntimeArtifacts({ rootDir: options.rootDir });
  const archiveDir = path.resolve(options.archiveDir ?? path.join(scan.root_dir, ".runtime", "env-backups"));
  const deleted: string[] = [];
  const archived: string[] = [];

  if (options.apply) {
    await mkdir(archiveDir, { recursive: true });
    for (const file of scan.files) {
      if (file.kind === "projector_status_tmp") {
        await rm(file.path, { force: true });
        deleted.push(file.path);
      } else if (file.kind === "env_backup") {
        const target = path.join(archiveDir, file.name);
        await rename(file.path, target);
        archived.push(target);
      }
    }
  }

  return {
    ...scan,
    apply: options.apply,
    archive_dir: archiveDir,
    deleted,
    archived
  };
}

function classifyArtifact(name: string): RuntimeArtifactKind | null {
  if (PROJECTOR_TMP_PATTERN.test(name)) return "projector_status_tmp";
  if (ENV_BACKUP_PATTERN.test(name)) return "env_backup";
  return null;
}
