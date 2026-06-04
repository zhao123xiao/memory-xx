import { ProjectionView } from "../types";
import { ProjectionErrorCode } from "./errors";

export enum ExporterStateStatus {
  Idle = "idle",
  Exporting = "exporting",
  Rebuilding = "rebuilding",
  Failed = "failed"
}

export interface ExporterViewState {
  readonly lastProjectionAt?: string;
  readonly lastStableId?: string;
  readonly lastErrorCode?: ProjectionErrorCode;
}

export interface ProjectionExporterState {
  readonly exporterVersion: string;
  readonly status: ExporterStateStatus;
  readonly activeJobId?: string;
  readonly lastCompletedJobId?: string;
  readonly lastFailedJobId?: string;
  readonly views: Readonly<Partial<Record<ProjectionView, ExporterViewState>>>;
}
