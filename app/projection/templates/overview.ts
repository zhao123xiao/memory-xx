import { ProjectionView, type ProjectionDocument, type ProjectionRecord } from "../types";
import { buildSkeletonTemplate } from "./helpers";

export function createOverviewTemplate(record: ProjectionRecord): ProjectionDocument {
  return buildSkeletonTemplate({
    view: ProjectionView.Overview,
    record,
    sectionHeading: "Summary",
    sectionBody: record.summary ?? record.body ?? "Overview projection placeholder."
  });
}
