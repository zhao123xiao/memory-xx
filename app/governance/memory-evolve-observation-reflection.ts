import {
  buildObservationReflectionReportFromRows,
  buildObservationReviewQueueFromRows,
  type BuildObservationReflectionReportFromRowsInput,
  type ObservationReviewQueueReport,
  type ObservationReflectionReport,
} from "./observer-reflector-governor";

export type MemoryEvolveObservationReflectionSection =
  Omit<Pick<ObservationReflectionReport, "summary" | "candidates">, "summary"> & {
    readonly summary: ObservationReflectionReport["summary"] & {
      readonly review_queue_items: number;
      readonly retention_only_items: number;
      readonly actionable_review_items: number;
      readonly review_queue_by_queue: ObservationReviewQueueReport["summary"]["by_queue"];
    };
    readonly review_queue: ObservationReviewQueueReport;
  };

export function buildMemoryEvolveObservationReflectionSection(
  input: BuildObservationReflectionReportFromRowsInput,
): MemoryEvolveObservationReflectionSection {
  const report = buildObservationReflectionReportFromRows(input);
  const reviewQueue = buildObservationReviewQueueFromRows({
    ...input,
    reflectionReport: report,
  });
  return {
    summary: {
      ...report.summary,
      review_queue_items: reviewQueue.summary.total_review_items,
      retention_only_items: reviewQueue.summary.retention_only_items,
      actionable_review_items: reviewQueue.summary.actionable_review_items,
      review_queue_by_queue: reviewQueue.summary.by_queue,
    },
    candidates: report.candidates,
    review_queue: reviewQueue,
  };
}
