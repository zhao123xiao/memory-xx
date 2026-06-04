import { ProjectionAudience, ProjectionView, type ProjectionDocument, type ProjectionRecord } from "../types";
import { buildSkeletonTemplate } from "./helpers";

export function createGovernanceTemplate(record: ProjectionRecord): ProjectionDocument {
  return buildSkeletonTemplate({
    view: ProjectionView.Governance,
    record,
    sectionHeading: "Governance",
    sectionBody: record.body ?? "Governance projection placeholder.",
    visibility: ProjectionAudience.Internal
  });
}
