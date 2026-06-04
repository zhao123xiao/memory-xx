import { ProjectionView, type ProjectionDocument, type ProjectionRecord } from "../types";
import { buildSkeletonTemplate } from "./helpers";

export function createDailyTemplate(record: ProjectionRecord): ProjectionDocument {
  return buildSkeletonTemplate({
    view: ProjectionView.Daily,
    record,
    sectionHeading: "Daily Note",
    sectionBody: record.body ?? "Daily projection placeholder."
  });
}
