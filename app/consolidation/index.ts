export { runConsolidation, type ConsolidationDeps, type ConsolidationResult, type DuplicateGroup, type ConflictPair } from "./worker";
export { groupIntoEpisodes, type EpisodicRecord, type EpisodeGroup } from "./episode-builder";
export { resolveConflict, type ConflictRecord, type ConflictResolution } from "./conflict-resolver";
export { mergeContents, type MergeCandidate, type MergeResult } from "./merge-engine";
