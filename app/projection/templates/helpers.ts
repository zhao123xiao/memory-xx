import { PROJECTION_EXPORTER_VERSION } from "../constants";
import { buildStableProjectionId } from "../mapper";
import {
  ProjectionAggregationGrain,
  ProjectionAudience,
  ProjectionDocumentKind,
  ProjectionView,
  type ProjectionDocument,
  type ProjectionDocumentSection,
  type ProjectionFrontmatterMap,
  type ProjectionRecord
} from "../types";

interface SkeletonTemplateInput {
  readonly view: ProjectionView;
  readonly record: ProjectionRecord;
  readonly titlePrefix?: string;
  readonly sectionHeading: string;
  readonly sectionBody: string;
  readonly visibility?: ProjectionAudience;
}

export function buildSkeletonTemplate(input: SkeletonTemplateInput): ProjectionDocument {
  const projectionId = buildStableProjectionId({
    view: input.view,
    grain: ProjectionAggregationGrain.Record,
    keyParts: [input.record.recordId]
  });

  const sections: ProjectionDocumentSection[] = [
    {
      heading: input.sectionHeading,
      body: input.sectionBody
    }
  ];

  const frontmatter: ProjectionFrontmatterMap = {
    projection_id: projectionId,
    view: input.view,
    title: `${input.titlePrefix ?? ""}${input.record.title}`.trim(),
    scope: input.record.scope,
    visibility: input.visibility ?? ProjectionAudience.Shared,
    document_kind: ProjectionDocumentKind.Record,
    source_record_ids: input.record.sourceRecordIds ?? [input.record.recordId],
    generated_at: input.record.updatedAt ?? input.record.createdAt ?? "1970-01-01T00:00:00.000Z",
    exporter_version: PROJECTION_EXPORTER_VERSION,
    record_id: input.record.recordId,
    lifecycle_status: input.record.lifecycleStatus,
    review_state: input.record.reviewState,
    is_current: input.record.isCurrent,
    decision_date: input.record.decisionDate,
    due_date: input.record.dueDate,
    occurred_at: input.record.occurredAt,
    archived_at: input.record.archivedAt,
    project_key: input.record.projectKey,
    tags: input.record.tags
  };

  return {
    projectionId,
    view: input.view,
    kind: ProjectionDocumentKind.Record,
    title: frontmatter.title as string,
    slug: input.record.slug,
    visibility: (frontmatter.visibility as ProjectionAudience | undefined) ?? ProjectionAudience.Shared,
    frontmatter,
    sections
  };
}
