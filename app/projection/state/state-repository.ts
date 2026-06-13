import { promises as fs } from "node:fs";
import path from "node:path";

import { PROJECTION_EXPORTER_VERSION, PROJECTION_ROOT_DIR } from "../constants";
import { ProjectionView, type ProjectionJob } from "../types";
import { ProjectionJobStatus, type ProjectionJobState } from "./job";

export interface ExporterViewStateSnapshot {
  readonly lastProjectionAt?: string;
  readonly recordIds: readonly string[];
  readonly stableIds: readonly string[];
}

export interface ExporterRecordStateSnapshot {
  readonly recordId: string;
  readonly views: readonly ProjectionView[];
  readonly pathsByView: Readonly<Partial<Record<ProjectionView, string>>>;
}

/**
 * On-disk exporter runtime state used by projection runner.
 * Kept intentionally compact but sufficient for incremental delete/rebuild.
 */
export interface ExporterStateFile {
  readonly exporterVersion: string;
  readonly status: "idle" | "exporting" | "rebuilding" | "failed";
  readonly activeJobId?: string;
  readonly lastCompletedJobId?: string;
  readonly lastFailedJobId?: string;
  readonly lastSuccessAt?: string;
  readonly lastFailureSummary?: string;
  readonly poisonedJobIds?: readonly string[];
  readonly jobHistory: readonly ProjectionJobState[];
  readonly views: Readonly<Partial<Record<ProjectionView, ExporterViewStateSnapshot>>>;
  readonly records: Readonly<Record<string, ExporterRecordStateSnapshot>>;
}

const STATE_FILE_NAME = ".exporter-state.json";
const MAX_JOB_HISTORY = 20;

export class ExporterStateRepository {
  private readonly statePath: string;

  constructor(rootDir: string = PROJECTION_ROOT_DIR) {
    this.statePath = path.join(rootDir, STATE_FILE_NAME);
  }

  get filePath(): string {
    return this.statePath;
  }

  async load(): Promise<ExporterStateFile> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ExporterStateFile>;
      return this.normalizeState(parsed);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return this.emptyState();
      }
      throw error;
    }
  }

  async save(state: ExporterStateFile): Promise<void> {
    const dir = path.dirname(this.statePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.statePath);
  }

  async startJob(job: ProjectionJob): Promise<ExporterStateFile> {
    const current = await this.load();
    const nextStatus = job.type === "incremental_export" ? "exporting" : "rebuilding";
    const historyEntry: ProjectionJobState = {
      jobId: job.jobId,
      type: job.type,
      status: ProjectionJobStatus.Running,
      requestedAt: job.requestedAt,
      startedAt: new Date().toISOString(),
      attempts: 1
    };

    const updated: ExporterStateFile = {
      ...current,
      status: nextStatus,
      activeJobId: job.jobId,
      jobHistory: [historyEntry, ...current.jobHistory].slice(0, MAX_JOB_HISTORY)
    };
    await this.save(updated);
    return updated;
  }

  async markJobCompleted(
    jobId: string,
    success: boolean,
    patch: {
      readonly completedAt?: string;
      readonly failureSummary?: string;
      readonly views?: Readonly<Partial<Record<ProjectionView, ExporterViewStateSnapshot>>>;
      readonly records?: Readonly<Record<string, ExporterRecordStateSnapshot>>;
    } = {}
  ): Promise<ExporterStateFile> {
    const current = await this.load();
    const completedAt = patch.completedAt ?? new Date().toISOString();
    const updated: ExporterStateFile = {
      ...current,
      status: success ? "idle" : "failed",
      activeJobId: undefined,
      lastCompletedJobId: success ? jobId : current.lastCompletedJobId,
      lastFailedJobId: success ? undefined : jobId,
      lastSuccessAt: success ? completedAt : current.lastSuccessAt,
      lastFailureSummary: success ? undefined : (patch.failureSummary ?? current.lastFailureSummary),
      views: patch.views ?? current.views,
      records: patch.records ?? current.records,
      jobHistory: current.jobHistory.map((entry) => entry.jobId === jobId
        ? {
            ...entry,
            status: success ? ProjectionJobStatus.Succeeded : ProjectionJobStatus.Failed,
            completedAt
          }
        : entry)
    };
    await this.save(updated);
    return updated;
  }

  async markJobPoisoned(jobId: string, reason: string): Promise<ExporterStateFile> {
    const current = await this.load();
    const poisoned = [...(current.poisonedJobIds ?? []), jobId];
    const updated: ExporterStateFile = {
      ...current,
      status: "failed",
      activeJobId: undefined,
      lastFailedJobId: jobId,
      lastFailureSummary: reason,
      poisonedJobIds: poisoned,
      jobHistory: current.jobHistory.map((entry) => entry.jobId === jobId
        ? {
            ...entry,
            status: ProjectionJobStatus.Poisoned,
            completedAt: new Date().toISOString()
          }
        : entry)
    };
    await this.save(updated);
    return updated;
  }

  private emptyState(): ExporterStateFile {
    return {
      exporterVersion: PROJECTION_EXPORTER_VERSION,
      status: "idle",
      jobHistory: [],
      views: {},
      records: {}
    };
  }

  private normalizeState(state: Partial<ExporterStateFile>): ExporterStateFile {
    return {
      exporterVersion: state.exporterVersion ?? PROJECTION_EXPORTER_VERSION,
      status: state.status ?? "idle",
      activeJobId: state.activeJobId,
      lastCompletedJobId: state.lastCompletedJobId,
      lastFailedJobId: state.lastFailedJobId,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureSummary: state.lastFailureSummary,
      poisonedJobIds: state.poisonedJobIds ?? [],
      jobHistory: state.jobHistory ?? [],
      views: state.views ?? {},
      records: state.records ?? {}
    };
  }
}
