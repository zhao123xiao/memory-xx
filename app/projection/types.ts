import type { OutboxEventType } from "../shared";
import { LifecycleStatus, ReviewState, ScopeType } from "../shared";

export enum ProjectionView {
  Overview = "overview",
  Decisions = "decisions",
  Projects = "projects",
  Todos = "todos",
  Daily = "daily",
  Governance = "governance",
  Archive = "archive"
}

export enum ProjectionDocumentKind {
  Index = "index",
  Aggregate = "aggregate",
  Record = "record"
}

export enum ProjectionAudience {
  Shared = "shared",
  Private = "private",
  Internal = "internal"
}

export enum ProjectionAggregationGrain {
  Index = "index",
  Record = "record",
  Project = "project",
  Date = "date",
  Bucket = "bucket",
  Scope = "scope"
}

export enum ProjectionJobType {
  IncrementalExport = "incremental_export",
  ScopedRebuild = "scoped_rebuild",
  FullRebuild = "full_rebuild"
}

export type ProjectionFrontmatterScalar = string | number | boolean | null;
export type ProjectionFrontmatterValue =
  | ProjectionFrontmatterScalar
  | readonly ProjectionFrontmatterScalar[]
  | ProjectionFrontmatterMap
  | readonly ProjectionFrontmatterMap[];

export interface ProjectionFrontmatterMap {
  readonly [key: string]: ProjectionFrontmatterValue | undefined;
}

export interface ProjectionDocumentSection {
  readonly heading?: string;
  readonly level?: 2 | 3 | 4;
  readonly body: string | readonly string[];
}

export interface ProjectionPathInput {
  readonly rootDir?: string;
  readonly view: ProjectionView;
  readonly stableId: string;
  readonly kind?: ProjectionDocumentKind;
  readonly slug?: string;
  readonly bucketSegments?: readonly string[];
  readonly extension?: string;
}

export interface ResolvedProjectionPath {
  readonly rootDir: string;
  readonly view: ProjectionView;
  readonly directory: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly relativePath: string;
  readonly bucketSegments: readonly string[];
  readonly slug: string;
}

export interface ProjectionStableIdInput {
  readonly view: ProjectionView;
  readonly grain: ProjectionAggregationGrain;
  readonly keyParts: readonly string[];
}

export interface ProjectionRecord {
  readonly recordId: string;
  readonly scope: ScopeType;
  readonly lifecycleStatus: LifecycleStatus;
  readonly reviewState: ReviewState;
  readonly isCurrent: boolean;
  readonly title: string;
  readonly body?: string;
  readonly summary?: string;
  readonly slug?: string;
  readonly sourceRecordIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly candidateViews?: readonly ProjectionView[];
  readonly primaryView?: ProjectionView;
  readonly forceGovernance?: boolean;
  readonly projectKey?: string;
  readonly decisionDate?: string;
  readonly dueDate?: string;
  readonly occurredAt?: string;
  readonly submittedAt?: string;
  readonly archivedAt?: string;
  readonly updatedAt?: string;
  readonly createdAt?: string;
  readonly weight?: number;
  readonly queue?: string;
  readonly archiveBucket?: string;
  readonly statePriority?: number;
}

export interface ProjectionDocument {
  readonly projectionId: string;
  readonly view: ProjectionView;
  readonly kind: ProjectionDocumentKind;
  readonly title: string;
  readonly slug?: string;
  readonly visibility: ProjectionAudience;
  readonly bucketSegments?: readonly string[];
  readonly frontmatter: ProjectionFrontmatterMap;
  readonly sections: readonly ProjectionDocumentSection[];
}

export interface ProjectionSortableItem {
  readonly stableId: string;
  readonly title?: string;
  readonly weight?: number;
  readonly updatedAt?: string;
  readonly decisionDate?: string;
  readonly dueDate?: string;
  readonly occurredAt?: string;
  readonly submittedAt?: string;
  readonly archivedAt?: string;
  readonly projectKey?: string;
  readonly queue?: string;
  readonly archiveBucket?: string;
  readonly statePriority?: number;
}

export interface ProjectionVisibilityDecision {
  readonly visibleViews: readonly ProjectionView[];
  readonly sharedNavigationViews: readonly ProjectionView[];
  readonly audienceByView: Readonly<Partial<Record<ProjectionView, ProjectionAudience>>>;
}

export interface ProjectionJobBase {
  readonly jobId: string;
  readonly type: ProjectionJobType;
  readonly requestedAt: string;
  readonly triggeredBy: string;
  readonly rootDir?: string;
  readonly reason?: string;
}

export interface IncrementalProjectionJob extends ProjectionJobBase {
  readonly type: ProjectionJobType.IncrementalExport;
  readonly affectedRecordIds: readonly string[];
  readonly eventTypes?: readonly OutboxEventType[];
}

export interface ScopedRebuildProjectionJob extends ProjectionJobBase {
  readonly type: ProjectionJobType.ScopedRebuild;
  readonly views: readonly ProjectionView[];
  readonly scope: ScopeType;
  readonly stableIds?: readonly string[];
}

export interface FullRebuildProjectionJob extends ProjectionJobBase {
  readonly type: ProjectionJobType.FullRebuild;
  readonly views?: readonly ProjectionView[];
}

export type ProjectionJob =
  | IncrementalProjectionJob
  | ScopedRebuildProjectionJob
  | FullRebuildProjectionJob;
