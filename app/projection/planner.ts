import { classifyRecordToViews } from "./mapper/classify-record";
import { buildStableProjectionId } from "./mapper/stable-id";
import {
  ProjectionAggregationGrain,
  ProjectionDocumentKind,
  ProjectionView,
  type ProjectionRecord
} from "./types";

export interface AffectedProjectionDoc {
  readonly stableId: string;
  readonly view: ProjectionView;
  readonly kind: ProjectionDocumentKind;
  readonly recordId: string;
  readonly remove: boolean;
}

export interface PreviousClassificationState {
  readonly recordId: string;
  readonly views: readonly ProjectionView[];
}

export function planIncrementalExport(
  currentRecords: readonly ProjectionRecord[],
  previousRecords: readonly PreviousClassificationState[] = []
): AffectedProjectionDoc[] {
  const docs = new Map<string, AffectedProjectionDoc>();
  const currentViewsByRecord = new Map<string, Set<ProjectionView>>();

  for (const record of currentRecords) {
    const views = classifyRecordToViews(record);
    currentViewsByRecord.set(record.recordId, new Set(views));

    for (const view of views) {
      docs.set(docKey(view, record.recordId, ProjectionDocumentKind.Record), {
        stableId: buildStableProjectionId({
          view,
          grain: ProjectionAggregationGrain.Record,
          keyParts: [record.recordId]
        }),
        view,
        kind: ProjectionDocumentKind.Record,
        recordId: record.recordId,
        remove: false
      });

      docs.set(docKey(view, "", ProjectionDocumentKind.Index), {
        stableId: buildStableProjectionId({
          view,
          grain: ProjectionAggregationGrain.Index,
          keyParts: ["index"]
        }),
        view,
        kind: ProjectionDocumentKind.Index,
        recordId: "",
        remove: false
      });
    }
  }

  for (const previous of previousRecords) {
    const currentViews = currentViewsByRecord.get(previous.recordId) ?? new Set<ProjectionView>();
    for (const view of previous.views) {
      if (currentViews.has(view)) continue;

      docs.set(docKey(view, previous.recordId, ProjectionDocumentKind.Record), {
        stableId: buildStableProjectionId({
          view,
          grain: ProjectionAggregationGrain.Record,
          keyParts: [previous.recordId]
        }),
        view,
        kind: ProjectionDocumentKind.Record,
        recordId: previous.recordId,
        remove: true
      });

      docs.set(docKey(view, "", ProjectionDocumentKind.Index), {
        stableId: buildStableProjectionId({
          view,
          grain: ProjectionAggregationGrain.Index,
          keyParts: ["index"]
        }),
        view,
        kind: ProjectionDocumentKind.Index,
        recordId: "",
        remove: false
      });
    }
  }

  return Array.from(docs.values());
}

export interface RebuildPlan {
  readonly views: readonly ProjectionView[];
  readonly docs: readonly AffectedProjectionDoc[];
}

export function planFullRebuild(
  records: readonly ProjectionRecord[],
  views?: readonly ProjectionView[]
): RebuildPlan {
  const targetViews = views ?? Object.values(ProjectionView);
  return planRebuildForViews(records, targetViews);
}

export function planScopedRebuild(
  records: readonly ProjectionRecord[],
  views: readonly ProjectionView[]
): RebuildPlan {
  return planRebuildForViews(records, views);
}

function planRebuildForViews(
  records: readonly ProjectionRecord[],
  views: readonly ProjectionView[]
): RebuildPlan {
  const docs = new Map<string, AffectedProjectionDoc>();

  for (const record of records) {
    const classifiedViews = classifyRecordToViews(record);
    for (const view of classifiedViews) {
      if (!views.includes(view)) continue;

      docs.set(docKey(view, record.recordId, ProjectionDocumentKind.Record), {
        stableId: buildStableProjectionId({
          view,
          grain: ProjectionAggregationGrain.Record,
          keyParts: [record.recordId]
        }),
        view,
        kind: ProjectionDocumentKind.Record,
        recordId: record.recordId,
        remove: false
      });
    }
  }

  for (const view of views) {
    docs.set(docKey(view, "", ProjectionDocumentKind.Index), {
      stableId: buildStableProjectionId({
        view,
        grain: ProjectionAggregationGrain.Index,
        keyParts: ["index"]
      }),
      view,
      kind: ProjectionDocumentKind.Index,
      recordId: "",
      remove: false
    });
  }

  return { views: [...views], docs: Array.from(docs.values()) };
}

function docKey(view: ProjectionView, recordId: string, kind: ProjectionDocumentKind): string {
  return `${view}:${kind}:${recordId}`;
}
