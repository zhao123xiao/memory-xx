#!/usr/bin/env tsx
/**
 * Recall Quality Feedback
 *
 * Collects and analyzes recall quality feedback.
 *
 * Usage:
 *   npm run memory:recall-quality-feedback -- --json
 */
import { buildRecallQualityFeedbackReport } from "../app/governance/recall-quality-feedback";

console.log("Recall Quality Feedback Report");
console.log("================================");
console.log("");

const report = buildRecallQualityFeedbackReport({
  traces: [],
  feedbackEvents: [],
  memories: [],
});

console.log(`Generated at: ${report.generated_at}`);
console.log(`Traces: ${report.summary.traces}`);
console.log(`Feedback events: ${report.summary.feedback_events}`);
console.log(`Cohorts: ${report.summary.cohorts}`);
console.log("");

if (report.cohorts.length > 0) {
  console.log("Cohorts with issues:");
  for (const cohort of report.cohorts) {
    if (cohort.suggested_action !== "none") {
      console.log(`  - ${cohort.query_type}/${cohort.memory_class}: ${cohort.suggested_action} (${cohort.negative_rate * 100}% negative)`);
    }
  }
} else {
  console.log("No feedback data available.");
}

console.log("");
console.log("Note: This is a sample report. Connect to database for actual data.");