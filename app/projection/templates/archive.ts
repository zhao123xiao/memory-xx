import { ProjectionAudience, ProjectionView, type ProjectionDocument, type ProjectionRecord } from "../types";
import { buildSkeletonTemplate } from "./helpers";

export function createArchiveTemplate(record: ProjectionRecord): ProjectionDocument {
  return buildSkeletonTemplate({
    view: ProjectionView.Archive,
    record,
    sectionHeading: "Archive",
    sectionBody: record.body ?? "Archive projection placeholder.",
    visibility: ProjectionAudience.Private
  });
}
