#!/usr/bin/env tsx
/**
 * Observation Reflection
 *
 * Generates reflection candidates from observations using the
 * observer-reflector-governor pipeline.
 *
 * Usage:
 *   npm run memory:observation-reflection -- --json
 */
import {
  buildObservationReflectionReportFromRows,
  buildObservationReviewQueueFromRows,
} from "../app/governance/observer-reflector-governor";

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
  console.log("Memory Observation Reflection Report");
  console.log("====================================");
  console.log("");
  console.log("Usage:");
  console.log("  npm run memory:observation-reflection            # Generate report");
  console.log("  npm run memory:observation-reflection -- --json   # JSON output");
  console.log("  npm run memory:observation-reflection -- --help   # Help");
  console.log("");
  process.exit(0);
}

const generatedAt = new Date().toISOString();

// Build with empty data — report-only by default
const reflectionReport = buildObservationReflectionReportFromRows({
  batches: [],
  events: [],
  generatedAt,
});

const reviewQueue = buildObservationReviewQueueFromRows({
  batches: [],
  events: [],
  generatedAt,
  reflectionReport,
});

if (isJson) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    generated_at: generatedAt,
    report_only: true,
    reflection: reflectionReport,
    review_queue: reviewQueue,
  }, null, 2)}\n`);
} else {
  console.log("Memory Observation Reflection Report");
  console.log("====================================");
  console.log("");
  console.log(`Generated at: ${generatedAt}`);
  console.log(`Total candidates: ${reflectionReport.summary.total_candidates}`);
  console.log(`Review queue items: ${reviewQueue.summary.total_review_items}`);
  console.log(`Retention only: ${reviewQueue.summary.retention_only_items}`);
  console.log(`Actionable review: ${reviewQueue.summary.actionable_review_items}`);
  console.log("");
  if (reflectionReport.candidates.length > 0) {
    console.log("Reflection candidates:");
    for (const candidate of reflectionReport.candidates) {
      console.log(`  - ${candidate.candidate_type}: ${candidate.candidate_id}`);
    }
  } else {
    console.log("No observation reflection candidates found.");
  }
  console.log("");
  console.log("Note: This is a sample report. Connect to database for actual data.");
}
