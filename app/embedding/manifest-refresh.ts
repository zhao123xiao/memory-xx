import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface EmbeddingManifestDirtyState {
  readonly dirty: boolean;
  readonly reason: string;
  readonly event_count: number;
  readonly first_marked_at: string;
  readonly last_marked_at: string;
  readonly last_refresh_at?: string;
}

export function manifestRefreshStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env.MEMORY_V2_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
  return path.join(runtimeDir, "embedding-manifest-refresh.json");
}

export async function readEmbeddingManifestDirtyState(env: NodeJS.ProcessEnv = process.env): Promise<EmbeddingManifestDirtyState | null> {
  try {
    const raw = await readFile(manifestRefreshStatePath(env), "utf8");
    return JSON.parse(raw) as EmbeddingManifestDirtyState;
  } catch {
    return null;
  }
}

export async function markEmbeddingManifestDirty(reason: string, env: NodeJS.ProcessEnv = process.env): Promise<EmbeddingManifestDirtyState> {
  const now = new Date().toISOString();
  const previous = await readEmbeddingManifestDirtyState(env);
  const next: EmbeddingManifestDirtyState = {
    dirty: true,
    reason,
    event_count: (previous?.event_count ?? 0) + 1,
    first_marked_at: previous?.dirty ? previous.first_marked_at : now,
    last_marked_at: now,
    last_refresh_at: previous?.last_refresh_at,
  };
  const filePath = manifestRefreshStatePath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export async function markEmbeddingManifestRefreshed(env: NodeJS.ProcessEnv = process.env): Promise<EmbeddingManifestDirtyState> {
  const now = new Date().toISOString();
  const previous = await readEmbeddingManifestDirtyState(env);
  const next: EmbeddingManifestDirtyState = {
    dirty: false,
    reason: previous?.reason ?? "refresh",
    event_count: previous?.event_count ?? 0,
    first_marked_at: previous?.first_marked_at ?? now,
    last_marked_at: previous?.last_marked_at ?? now,
    last_refresh_at: now,
  };
  const filePath = manifestRefreshStatePath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}
