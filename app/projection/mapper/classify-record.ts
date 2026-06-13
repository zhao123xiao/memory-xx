import {
  isEffectiveRecallable,
  LifecycleStatus,
  ReviewState
} from "../../shared";
import {
  ProjectionView,
  type ProjectionRecord
} from "../types";

/**
 * Classify a memory record into its canonical projection views.
 *
 * Rules (frozen by I0/I1):
 * 1. Effective-recallable records enter their primaryView/candidateViews on main views.
 * 2. Non-recallable records go to governance only (not shared navigation).
 * 3. Archived/superseded/tombstone also go to archive.
 * 4. forceGovernance always adds governance.
 */
export function classifyRecordToViews(record: ProjectionRecord): ProjectionView[] {
  const views = new Set<ProjectionView>();
  const recallable = isEffectiveRecallable({
    lifecycleStatus: record.lifecycleStatus,
    isCurrent: record.isCurrent,
    reviewState: record.reviewState
  });

  if (recallable) {
    if (record.primaryView) {
      views.add(record.primaryView);
    }
    for (const v of record.candidateViews ?? []) {
      views.add(v);
    }
    // Remove governance from main view set if explicitly not wanted
    // (governance is added separately below for non-recallable)
  }

  // Governance: non-recallable always goes to governance
  if (!recallable || record.forceGovernance) {
    views.add(ProjectionView.Governance);
  }

  // Archive: archived/superseded/tombstone
  if (
    record.lifecycleStatus === LifecycleStatus.Archived ||
    record.lifecycleStatus === LifecycleStatus.Superseded ||
    record.lifecycleStatus === LifecycleStatus.Tombstone
  ) {
    views.add(ProjectionView.Archive);
  }

  // If candidateViews explicitly includes governance or archive, respect it
  if (record.candidateViews?.includes(ProjectionView.Governance)) {
    views.add(ProjectionView.Governance);
  }
  if (record.candidateViews?.includes(ProjectionView.Archive)) {
    views.add(ProjectionView.Archive);
  }

  // If no view at all assigned (e.g. recallable but no primary/candidate), default to overview
  if (recallable && views.size === 0) {
    views.add(ProjectionView.Overview);
  }

  return Array.from(views);
}

/**
 * Returns the audience for a given view/record combination.
 */
export function audienceForView(
  view: ProjectionView,
  record: ProjectionRecord
): "shared" | "private" | "internal" {
  if (view === ProjectionView.Governance) return "internal";
  if (view === ProjectionView.Archive) return "private";

  const recallable = isEffectiveRecallable({
    lifecycleStatus: record.lifecycleStatus,
    isCurrent: record.isCurrent,
    reviewState: record.reviewState
  });
  return recallable ? "shared" : "internal";
}
