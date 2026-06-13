import { createLogger } from "../shared/logger";

const log = createLogger("consolidation-worker");

export interface ConsolidationDeps {
  readonly findDuplicates: () => Promise<readonly DuplicateGroup[]>;
  readonly findConflicts: () => Promise<readonly ConflictPair[]>;
  readonly mergeDuplicates: (group: DuplicateGroup) => Promise<string | null>;
  readonly resolveConflict: (conflict: ConflictPair) => Promise<string | null>;
  readonly buildEpisodes: (windowHours: number) => Promise<number>;
  readonly runInJobTransaction?: <TResult>(work: () => Promise<TResult>) => Promise<TResult>;
  readonly recordCompensation?: (entry: ConsolidationCompensationEntry) => Promise<void>;
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

export interface ConsolidationCompensationEntry {
  readonly stage: "findDuplicates" | "dedupe" | "findConflicts" | "conflict" | "buildEpisodes";
  readonly reason: string;
  readonly target_id?: string;
}

function readEpisodeWindowHours(): number {
  const raw = process.env.MEMORY_XX_EPISODE_WINDOW_HOURS?.trim();
  if (!raw) return 24;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

export async function runConsolidation(deps: ConsolidationDeps): Promise<ConsolidationResult> {
  const errors: string[] = [];
  let duplicatesMerged = 0;
  let conflictsResolved = 0;
  let episodesCreated = 0;
  const runInJobTransaction = deps.runInJobTransaction ?? (async (work) => work());
  const recordCompensation = async (entry: ConsolidationCompensationEntry) => {
    try {
      await deps.recordCompensation?.(entry);
    } catch (error) {
      errors.push("recordCompensation:" + entry.stage + ": " + (error as Error).message);
    }
  };

  await runInJobTransaction(async () => {
    try {
      const duplicates = await deps.findDuplicates();
      for (const group of duplicates) {
        try {
          const merged = await deps.mergeDuplicates(group);
          if (merged) duplicatesMerged++;
        } catch (error) {
          const reason = (error as Error).message;
          errors.push("dedupe:" + group.dedupe_key + ": " + reason);
          await recordCompensation({ stage: "dedupe", target_id: group.dedupe_key, reason });
        }
      }
    } catch (error) {
      const reason = (error as Error).message;
      errors.push("findDuplicates: " + reason);
      await recordCompensation({ stage: "findDuplicates", reason });
    }

    try {
      const conflicts = await deps.findConflicts();
      for (const conflict of conflicts) {
        try {
          const resolved = await deps.resolveConflict(conflict);
          if (resolved) conflictsResolved++;
        } catch (error) {
          const reason = (error as Error).message;
          errors.push("conflict:" + conflict.memory_id_a + ": " + reason);
          await recordCompensation({ stage: "conflict", target_id: conflict.memory_id_a, reason });
        }
      }
    } catch (error) {
      const reason = (error as Error).message;
      errors.push("findConflicts: " + reason);
      await recordCompensation({ stage: "findConflicts", reason });
    }

    try {
      episodesCreated = await deps.buildEpisodes(readEpisodeWindowHours());
    } catch (error) {
      const reason = (error as Error).message;
      errors.push("buildEpisodes: " + reason);
      await recordCompensation({ stage: "buildEpisodes", reason });
    }
  });

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
