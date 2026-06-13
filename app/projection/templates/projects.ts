import { ProjectionView, type ProjectionDocument, type ProjectionRecord } from "../types";
import { buildSkeletonTemplate } from "./helpers";

export function createProjectTemplate(record: ProjectionRecord): ProjectionDocument {
  return buildSkeletonTemplate({
    view: ProjectionView.Projects,
    record,
    sectionHeading: "Project State",
    sectionBody: record.body ?? "Project projection placeholder."
  });
}
