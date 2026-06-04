import path from "node:path";

import { LifecycleStatus } from "../shared";
import { ProjectionAudience, ProjectionView } from "./types";

export const PROJECTION_ROOT_DIR =
  process.env.MEMORY_XX_PROJECTION_ROOT_DIR?.trim() ||
  path.join(process.cwd(), "memory_projection");
export const PROJECTION_EXPORTER_VERSION = "phase-b3-foundation";
export const PROJECTION_MARKDOWN_EXTENSION = ".md";
export const PROJECTION_INDEX_FILE_NAME = `index${PROJECTION_MARKDOWN_EXTENSION}`;
export const PROJECTION_TEMP_FILE_PREFIX = ".projection-tmp";

export const PROJECTION_VIEWS = [
  ProjectionView.Overview,
  ProjectionView.Decisions,
  ProjectionView.Projects,
  ProjectionView.Todos,
  ProjectionView.Daily,
  ProjectionView.Governance,
  ProjectionView.Archive
] as const satisfies ReadonlyArray<ProjectionView>;

export const PROJECTION_VIEW_DIRECTORIES = {
  [ProjectionView.Overview]: "overview",
  [ProjectionView.Decisions]: "decisions",
  [ProjectionView.Projects]: "projects",
  [ProjectionView.Todos]: "todos",
  [ProjectionView.Daily]: "daily",
  [ProjectionView.Governance]: "governance",
  [ProjectionView.Archive]: "archive"
} as const satisfies Readonly<Record<ProjectionView, string>>;

export const PROJECTION_SHARED_NAVIGATION_VIEWS = [
  ProjectionView.Overview,
  ProjectionView.Decisions,
  ProjectionView.Projects,
  ProjectionView.Todos,
  ProjectionView.Daily
] as const satisfies ReadonlyArray<ProjectionView>;

export const PROJECTION_INTERNAL_ONLY_VIEWS = [
  ProjectionView.Governance
] as const satisfies ReadonlyArray<ProjectionView>;

export const PROJECTION_PRIVATE_VIEWS = [
  ProjectionView.Archive,
  ProjectionView.Governance
] as const satisfies ReadonlyArray<ProjectionView>;

export const PROJECTION_DEFAULT_AUDIENCE_BY_VIEW = {
  [ProjectionView.Overview]: ProjectionAudience.Shared,
  [ProjectionView.Decisions]: ProjectionAudience.Shared,
  [ProjectionView.Projects]: ProjectionAudience.Shared,
  [ProjectionView.Todos]: ProjectionAudience.Shared,
  [ProjectionView.Daily]: ProjectionAudience.Shared,
  [ProjectionView.Governance]: ProjectionAudience.Internal,
  [ProjectionView.Archive]: ProjectionAudience.Private
} as const satisfies Readonly<Record<ProjectionView, ProjectionAudience>>;

export const PROJECTION_FRONTMATTER_KEY_ORDER = [
  "projection_id",
  "view",
  "title",
  "scope",
  "visibility",
  "document_kind",
  "source_record_ids",
  "generated_at",
  "exporter_version",
  "record_id",
  "lifecycle_status",
  "review_state",
  "is_current",
  "decision_date",
  "due_date",
  "occurred_at",
  "archived_at",
  "project_key",
  "tags"
] as const;

export const PROJECTION_ARCHIVE_LIFECYCLE_STATUSES = [
  LifecycleStatus.Archived,
  LifecycleStatus.Superseded,
  LifecycleStatus.Tombstone
] as const satisfies ReadonlyArray<LifecycleStatus>;
