#!/usr/bin/env tsx
/**
 * Extraction-Recall Evaluation
 *
 * Evaluates the quality of extraction and recall pipeline.
 *
 * Usage:
 *   npm run memory:extraction-recall-eval -- --json
 */
import { buildExtractionRecallEvalReport } from "../app/governance/extraction-recall-eval";

console.log("Extraction-Recall Evaluation Report");
console.log("=====================================");
console.log("");

const report = buildExtractionRecallEvalReport({
  traces: [],
  feedbackEvents: [],
  memories: [],
});

console.log(`Generated at: ${report.generated_at}`);
console.log(`Traces: ${report.summary.traces}`);
console.log(`Feedback events: ${report.summary.feedback_events}`);
console.log(`Cohorts: ${report.summary.cohorts}`);
console.log(`Mismatch cohorts: ${report.summary.mismatch_cohorts}`);
console.log("");

if (report.cohorts.length > 0) {
  console.log("Cohorts with issues:");
  for (const cohort of report.cohorts) {
    if (cohort.suggested_action !== "none") {
      console.log(`  - ${cohort.query_type}/${cohort.memory_class}: ${cohort.suggested_action} (${cohort.mismatch_kind})`);
    }
  }
} else {
  console.log("No evaluation data available.");
}

console.log("");
console.log("Note: This is a sample report. Connect to database for actual data.");