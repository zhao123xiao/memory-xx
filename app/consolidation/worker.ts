import { createLogger } from "../shared/logger";

const log = createLogger("consolidation-worker");

export interface ConsolidationDeps {
  readonly findDuplicates: () => Promise<readonly DuplicateGroup[]>;
  readonly findConflicts: () => Promise<readonly ConflictPair[]>;
  readonly mergeDuplicates: (group: DuplicateGroup) => Promise<string | null>;
  readonly resolveConflict: (conflict: ConflictPair) => Promise<string | null>;
  readonly buildEpisodes: (windowHours: number) => Promise<number>;
}

export interface DuplicateGroup {
  readonly dedupe_key: string;
  readonly memory_ids: readonly string[];
  readonly scope_type: string;
  readonly scope_id: string;
}

export interface ConflictPair {
  readonly memory_id_a: string;
  readonly memory_id_b: string;
  readonly relation_type: string;
}

export interface ConsolidationResult {
  readonly duplicates_merged: number;
  readonly conflicts_resolved: number;
  readonly episodes_created: number;
  readonly errors: readonly string[];
}

function readEpisodeWindowHours(): number {
  const raw = process.env.MEMORY_V2_EPISODE_WINDOW_HOURS?.trim();
  if (!raw) return 24;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

export async function runConsolidation(deps: ConsolidationDeps): Promise<ConsolidationResult> {
  const errors: string[] = [];
  let duplicatesMerged = 0;
  let conflictsResolved = 0;

  try {
    const duplicates = await deps.findDuplicates();
    for (const group of duplicates) {
      try {
        const merged = await deps.mergeDuplicates(group);
        if (merged) duplicatesMerged++;
      } catch (error) {
        errors.push("dedupe:" + group.dedupe_key + ": " + (error as Error).message);
      }
    }
  } catch (error) {
    errors.push("findDuplicates: " + (error as Error).message);
  }

  try {
    const conflicts = await deps.findConflicts();
    for (const conflict of conflicts) {
      try {
        const resolved = await deps.resolveConflict(conflict);
        if (resolved) conflictsResolved++;
      } catch (error) {
        errors.push("conflict:" + conflict.memory_id_a + ": " + (error as Error).message);
      }
    }
  } catch (error) {
    errors.push("findConflicts: " + (error as Error).message);
  }

  let episodesCreated = 0;
  try {
    episodesCreated = await deps.buildEpisodes(readEpisodeWindowHours());
  } catch (error) {
    errors.push("buildEpisodes: " + (error as Error).message);
  }

  const result: ConsolidationResult = {
    duplicates_merged: duplicatesMerged,
    conflicts_resolved: conflictsResolved,
    episodes_created: episodesCreated,
    errors,
  };

  log.info("Consolidation run completed", {
    duplicates: duplicatesMerged,
    conflicts: conflictsResolved,
    episodes: episodesCreated,
    errors: errors.length,
  });

  return result;
}
