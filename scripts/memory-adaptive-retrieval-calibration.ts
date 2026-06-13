#!/usr/bin/env tsx
/**
 * Adaptive Retrieval Calibration
 *
 * Generates calibration recommendations for retrieval thresholds.
 *
 * Usage:
 *   npm run memory:adaptive-retrieval-calibration -- --json
 */
import { buildAdaptiveRetrievalCalibrationReport } from "../app/governance/adaptive-retrieval-calibration";

console.log("Adaptive Retrieval Calibration Report");
console.log("=======================================");
console.log("");

// Build a sample empty report
const report = buildAdaptiveRetrievalCalibrationReport({
  cohorts: [],
  generatedAt: new Date().toISOString(),
});

console.log(`Generated at: ${report.generated_at}`);
console.log(`Total cohorts: ${report.summary.total_cohorts}`);
console.log(`Actionable: ${report.summary.actionable_cohorts}`);
console.log("");

if (report.cohorts.length > 0) {
  console.log("Cohorts:");
  for (const cohort of report.cohorts) {
    console.log(`  - ${cohort.scope_key}/${cohort.query_type}: ${cohort.trace_count} traces`);
  }
} else {
  console.log("No calibration data available.");
}

console.log("");
console.log("Note: This is a sample report. Connect to database for actual data.");