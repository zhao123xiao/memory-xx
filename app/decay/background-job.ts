import { createLogger } from "../shared/logger";

const log = createLogger("decay-background-job");

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface DecayJobDeps {
  readonly queryRecords: () => Promise<readonly DecayRecord[]>;
  readonly updateStrength: (id: string, strength: number) => Promise<void>;
  readonly archiveRecord: (id: string) => Promise<void>;
}

export interface DecayRecord {
  readonly id: string;
  readonly importance: number;
  readonly usage_count: number;
  readonly support_count: number;
  readonly source_authority: number;
  readonly last_accessed_at: string | null;
  readonly conflict_count: number;
  readonly created_at: string;
  readonly fact_status: string;
}

let timer: ReturnType<typeof setInterval> | null = null;

function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

export function startDecayJob(deps: DecayJobDeps): void {
  if (timer) return;

  const tick = async () => {
    try {
      log.info("Decay tick started");
      const now = new Date().toISOString();
      const records = await deps.queryRecords();
      let archived = 0;
      let updated = 0;

      for (const record of records) {
        const lastAccess = record.last_accessed_at ?? record.created_at;
        const input = {
          importance: record.importance,
          usageCount: record.usage_count,
          supportCount: record.support_count,
          sourceAuthority: record.source_authority,
          daysSinceAccess: daysBetween(lastAccess, now),
          conflictCount: record.conflict_count,
          daysSinceCreated: daysBetween(record.created_at, now),
        };

        const { calculateMemoryStrength, shouldArchive } = require("./calculator");
        const strength = calculateMemoryStrength(input);

        await deps.updateStrength(record.id, strength);
        updated++;

        if (record.fact_status === "current" && shouldArchive(strength)) {
          await deps.archiveRecord(record.id);
          archived++;
        }
      }

      log.info("Decay tick completed", { checked: records.length, updated, archived });
    } catch (error) {
      log.error("Decay tick failed", { error: (error as Error).message });
    }
  };

  timer = setInterval(tick, INTERVAL_MS);
  // Run first tick immediately in background
  setTimeout(tick, 5000);
  log.info("Decay background job started", { interval_ms: INTERVAL_MS });
}

export function stopDecayJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("Decay background job stopped");
  }
}
