import { ProjectionView, type ProjectionDocument, type ProjectionRecord } from "../types";
import { buildSkeletonTemplate } from "./helpers";

export function createDecisionTemplate(record: ProjectionRecord): ProjectionDocument {
  return buildSkeletonTemplate({
    view: ProjectionView.Decisions,
    record,
    sectionHeading: "Decision",
    sectionBody: record.body ?? "Decision projection placeholder."
  });
}
