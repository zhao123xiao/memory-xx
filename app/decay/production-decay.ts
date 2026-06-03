import { calculateMemoryStrength, shouldArchive } from "./calculator";

export interface DecayCandidate {
  readonly id: string;
  readonly importance: number;
  readonly usageCount: number;
  readonly supportCount: number;
  readonly sourceAuthority: number;
  readonly daysSinceAccess: number;
  readonly conflictCount: number;
  readonly daysSinceCreated: number;
}

export interface DecayRunReport {
  readonly checked: number;
  readonly archive_candidate_ids: readonly string[];
}

export function selectDecayArchiveCandidates(candidates: readonly DecayCandidate[]): DecayRunReport {
  const archiveCandidateIds = candidates
    .filter((candidate) => shouldArchive(calculateMemoryStrength(candidate)))
    .map((candidate) => candidate.id);
  return {
    checked: candidates.length,
    archive_candidate_ids: archiveCandidateIds,
  };
}
