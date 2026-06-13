import { ProjectionView, type ProjectionDocument, type ProjectionRecord } from "../types";
import { buildSkeletonTemplate } from "./helpers";

export function createTodoTemplate(record: ProjectionRecord): ProjectionDocument {
  return buildSkeletonTemplate({
    view: ProjectionView.Todos,
    record,
    sectionHeading: "Todo",
    sectionBody: record.body ?? "Todo projection placeholder."
  });
}
