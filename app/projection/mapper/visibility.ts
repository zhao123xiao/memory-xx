import { isEffectiveRecallable, LifecycleStatus } from "../../shared";
import {
  PROJECTION_ARCHIVE_LIFECYCLE_STATUSES,
  PROJECTION_DEFAULT_AUDIENCE_BY_VIEW,
  PROJECTION_SHARED_NAVIGATION_VIEWS
} from "../constants";
import { ProjectionAudience, ProjectionView, type ProjectionRecord, type ProjectionVisibilityDecision } from "../types";

const MAIN_VIEW_SET = new Set<ProjectionView>(PROJECTION_SHARED_NAVIGATION_VIEWS);
const ARCHIVE_STATUS_SET = new Set<LifecycleStatus>(PROJECTION_ARCHIVE_LIFECYCLE_STATUSES);

function uniqueViews(views: readonly ProjectionView[]): ProjectionView[] {
  return Array.from(new Set(views));
}

function includesMainView(view: ProjectionView): boolean {
  return MAIN_VIEW_SET.has(view);
}

export function mapProjectionVisibility(record: ProjectionRecord): ProjectionVisibilityDecision {
  const effectiveRecallable = isEffectiveRecallable({
    lifecycleStatus: record.lifecycleStatus,
    isCurrent: record.isCurrent,
    reviewState: record.reviewState
  });

  const requestedViews = uniqueViews(
    [
      ...(record.primaryView ? [record.primaryView] : []),
      ...(record.candidateViews ?? [])
    ].filter((view): view is ProjectionView => view !== undefined)
  );

  const audienceByView: Partial<Record<ProjectionView, ProjectionAudience>> = {};
  const visibleViews: ProjectionView[] = [];

  if (effectiveRecallable) {
    for (const view of requestedViews.filter(includesMainView)) {
      visibleViews.push(view);
      audienceByView[view] = PROJECTION_DEFAULT_AUDIENCE_BY_VIEW[view];
    }
  }

  if (
    record.forceGovernance ||
    !effectiveRecallable ||
    requestedViews.includes(ProjectionView.Governance)
  ) {
    visibleViews.push(ProjectionView.Governance);
    audienceByView[ProjectionView.Governance] = ProjectionAudience.Internal;
  }

  if (
    ARCHIVE_STATUS_SET.has(record.lifecycleStatus) ||
    requestedViews.includes(ProjectionView.Archive)
  ) {
    visibleViews.push(ProjectionView.Archive);
    audienceByView[ProjectionView.Archive] = ProjectionAudience.Private;
  }

  const dedupedVisibleViews = uniqueViews(visibleViews);
  const sharedNavigationViews = dedupedVisibleViews.filter(
    (view) => MAIN_VIEW_SET.has(view) && audienceByView[view] === ProjectionAudience.Shared
  );

  return {
    visibleViews: dedupedVisibleViews,
    sharedNavigationViews,
    audienceByView
  };
}

export function isArchivedProjectionRecord(record: ProjectionRecord): boolean {
  return (
    record.lifecycleStatus === LifecycleStatus.Archived ||
    record.lifecycleStatus === LifecycleStatus.Superseded ||
    record.lifecycleStatus === LifecycleStatus.Tombstone
  );
}
