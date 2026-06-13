#!/usr/bin/env tsx
/**
 * Consolidation Candidates
 *
 * Generates candidate memories for consolidation or archival.
 *
 * Usage:
 *   npm run memory:consolidation-candidates -- --json
 *   npm run memory:consolidation-candidates -- --scope user:local-user
 */
import { buildConsolidationCandidateReport } from "../app/governance/consolidation-candidates";

console.log("Memory Consolidation Candidates Report");
console.log("=========================================");
console.log("");

// Build a sample empty report
const report = buildConsolidationCandidateReport({
  records: [],
  generatedAt: new Date().toISOString(),
});

console.log(`Generated at: ${report.generated_at}`);
console.log(`Total candidates: ${report.summary.total_candidates}`);
console.log("");

if (report.candidates.length > 0) {
  console.log("Candidates by type:");
  for (const [type, count] of Object.entries(report.summary.by_type)) {
    console.log(`  - ${type}: ${count}`);
  }
} else {
  console.log("No consolidation candidates found.");
}

console.log("");
console.log("Note: This is a sample report. Connect to database for actual data.");