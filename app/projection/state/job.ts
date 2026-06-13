import { ProjectionJobType, type ProjectionJob } from "../types";
import { ProjectionErrorCode } from "./errors";

export enum ProjectionJobStatus {
  Pending = "pending",
  Running = "running",
  Succeeded = "succeeded",
  Failed = "failed",
  Poisoned = "poisoned"
}

export interface ProjectionJobState {
  readonly jobId: string;
  readonly type: ProjectionJobType;
  readonly status: ProjectionJobStatus;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly attempts: number;
  readonly lastErrorCode?: ProjectionErrorCode;
}

export function isProjectionJobType(value: string): value is ProjectionJobType {
  return Object.values(ProjectionJobType).includes(value as ProjectionJobType);
}

export function isProjectionJob(value: unknown): value is ProjectionJob {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ProjectionJob>;
  if (
    typeof candidate.jobId !== "string" ||
    typeof candidate.requestedAt !== "string" ||
    typeof candidate.triggeredBy !== "string" ||
    typeof candidate.type !== "string" ||
    !isProjectionJobType(candidate.type)
  ) {
    return false;
  }

  switch (candidate.type) {
    case ProjectionJobType.IncrementalExport:
      return Array.isArray(candidate.affectedRecordIds);
    case ProjectionJobType.ScopedRebuild:
      return typeof candidate.scope === "string" && Array.isArray(candidate.views);
    case ProjectionJobType.FullRebuild:
      return candidate.views === undefined || Array.isArray(candidate.views);
    default:
      return false;
  }
}

export function createInitialProjectionJobState(job: ProjectionJob): ProjectionJobState {
  return {
    jobId: job.jobId,
    type: job.type,
    status: ProjectionJobStatus.Pending,
    requestedAt: job.requestedAt,
    attempts: 0
  };
}
