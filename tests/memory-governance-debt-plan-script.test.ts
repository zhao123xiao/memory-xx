import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("memory-governance-debt-plan report-only queries use production-only debt predicate", async () => {
  const source = await readFile("scripts/memory-governance-debt-plan.ts", "utf8");

  assert.match(source, /applyRequiredProvenanceBackfill/u);
  assert.match(source, /const applyRequiredProvenance = parseFlag\("--apply-required-provenance"\)/u);
  assert.match(source, /applyRequiredProvenance\s+\?\s+await applyRequiredProvenanceBackfill/u);
  assert.match(source, /const provenanceReportPredicate = buildGraphDebtBackfillScopePredicate\("mr", \{\s*productionOnly: !includeTestOnly,[\s\S]*excludeRelationDebt: false,/u);
  assert.match(source, /const graphReportPredicate = buildGraphDebtBackfillScopePredicate\("mr", \{\s*productionOnly: !includeTestOnly,/u);
  assert.match(source, /const requiredProvenancePredicate = buildGraphDebtBackfillScopePredicate\("mr", \{[\s\S]*excludeRelationDebt: false,/u);
  assert.match(source, /const graphStructurePredicate = buildGraphDebtBackfillScopePredicate\("mr", \{[\s\S]*relationTable: `\$\{schema\}\.memory_relations`,\s*\}\)/u);
  assert.match(source, /requiredProvenance = await pool\.query/u);
  assert.match(source, /required_provenance: requiredProvenance\.rows/u);
  assert.match(source, /missingMetadata = await pool\.query\(`[\s\S]*AND \$\{provenanceReportPredicate\}[\s\S]*ORDER BY mr\.updated_at DESC/u);
  assert.match(source, /graphOrphans = await pool\.query\(`[\s\S]*AND \$\{graphReportPredicate\}[\s\S]*ORDER BY mr\.updated_at DESC/u);
});
