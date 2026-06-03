import { calculateMemoryStrength, shouldArchive, type DecayInput } from "./calculator";

export interface AutoArchiveCandidate {
  readonly id: string;
  readonly importance: number;
  readonly usageCount: number;
  readonly supportCount: number;
  readonly sourceAuthority: number;
  readonly lastAccessedAt: string | null;
  readonly conflictCount: number;
  readonly createdAt: string;
}

export interface AutoArchiveResult {
  readonly archived_ids: readonly string[];
  readonly total_checked: number;
  readonly total_archived: number;
  readonly dry_run: boolean;
}

function daysBetween(dateA: string, dateB: string): number {
  const ms = new Date(dateB).getTime() - new Date(dateA).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function findArchiveCandidates(
  records: readonly AutoArchiveCandidate[],
  now: string,
  dryRun = true
): AutoArchiveResult {
  const archivedIds: string[] = [];

  for (const record of records) {
    const lastAccess = record.lastAccessedAt ?? record.createdAt;
    const input: DecayInput = {
      importance: record.importance,
      usageCount: record.usageCount,
      supportCount: record.supportCount,
      sourceAuthority: 0.5,
      daysSinceAccess: daysBetween(lastAccess, now),
      conflictCount: record.conflictCount,
      daysSinceCreated: daysBetween(record.createdAt, now),
    };

    const strength = calculateMemoryStrength(input);
    if (shouldArchive(strength)) {
      archivedIds.push(record.id);
    }
  }

  return {
    archived_ids: archivedIds,
    total_checked: records.length,
    total_archived: archivedIds.length,
    dry_run: dryRun,
  };
}
