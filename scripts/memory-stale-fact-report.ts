#!/usr/bin/env tsx
/**
 * Stale Fact Report
 *
 * Generates reports on potentially stale facts.
 *
 * Usage:
 *   npm run memory:stale-fact-report -- --json
 *   npm run memory:stale-fact-report -- --scope user:local-user
 */
import { buildStaleFactReport } from "../app/governance/stale-fact-report";

console.log("Memory Stale Fact Report");
console.log("========================");
console.log("");

// Build a sample empty report
const report = buildStaleFactReport({
  rows: [],
  generatedAt: new Date().toISOString(),
});

console.log(`Generated at: ${report.generated_at}`);
console.log(`Total candidates: ${report.summary.total_candidates}`);
console.log("");

if (report.candidates.length > 0) {
  console.log("Candidates:");
  for (const candidate of report.candidates) {
    console.log(`  - ${candidate.reason}: ${candidate.title ?? candidate.memory_id}`);
  }
} else {
  console.log("No stale fact candidates found.");
}

console.log("");
console.log("Note: This is a sample report. Connect to database for actual data.");