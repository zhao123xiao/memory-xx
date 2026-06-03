import { createLogger } from "../shared/logger";

const log = createLogger("episode-builder");

export interface EpisodicRecord {
  readonly id: string;
  readonly content: string;
  readonly created_at: string;
  readonly scope_type: string;
  readonly scope_id: string;
}

export interface EpisodeGroup {
  readonly records: readonly EpisodicRecord[];
  readonly started_at: string;
  readonly ended_at: string;
  readonly scope_key: string;
}

export function groupIntoEpisodes(
  records: readonly EpisodicRecord[],
  windowHours: number
): readonly EpisodeGroup[] {
  if (records.length === 0) return [];

  const sorted = [...records].sort(
    (a, b) => a.created_at.localeCompare(b.created_at)
  );

  const groups: EpisodeGroup[] = [];
  let current: EpisodicRecord[] = [sorted[0]];

  const windowMs = windowHours * 60 * 60 * 1000;

  for (let i = 1; i < sorted.length; i++) {
    const prevTime = new Date(current[current.length - 1].created_at).getTime();
    const currTime = new Date(sorted[i].created_at).getTime();

    if (currTime - prevTime <= windowMs) {
      current.push(sorted[i]);
    } else {
      if (current.length >= 2) {
        groups.push({
          records: [...current],
          started_at: current[0].created_at,
          ended_at: current[current.length - 1].created_at,
          scope_key: current[0].scope_type + ":" + current[0].scope_id,
        });
      }
      current = [sorted[i]];
    }
  }

  if (current.length >= 2) {
    groups.push({
      records: [...current],
      started_at: current[0].created_at,
      ended_at: current[current.length - 1].created_at,
      scope_key: current[0].scope_type + ":" + current[0].scope_id,
    });
  }

  log.info("Episode grouping completed", { input: records.length, groups: groups.length, windowHours });
  return groups;
}
