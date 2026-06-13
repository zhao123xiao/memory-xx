import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const DOC_PATH = "docs/open-source-release-readiness-2026-06-13.md";

function historicalPlanDocs(): string[] {
  const superpowersPlanDir = path.join(process.cwd(), "docs/superpowers/plans");
  const superpowersPlans = readdirSync(superpowersPlanDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/superpowers/plans/${name}`);

  return [
    "docs/governance-migration-plan.md",
    "docs/memory-v2-alignment-implementation-checklist-2026-06-09.md",
    ...superpowersPlans,
  ].sort();
}

test("open-source release readiness document records final mirror gates and boundaries", () => {
  const doc = readFileSync(path.join(process.cwd(), DOC_PATH), "utf8");

  for (const required of [
    "memory-xx open-source release readiness",
    "MEMORY_XX_*",
    "/api/memory/xx",
    "memory:parity-audit",
    "verify-open-source-parity",
    "sibling memory-v2 checkout",
    "verify:open-source",
    "test:prod-e2e",
    "test:load",
    "test:multi-agent-contract",
    "test:knowledge-e2e",
    "test:data-governance",
    "290795ac",
    "af3f36ec",
    "97c501e2",
    "b154a385",
    "5e6b37ff",
    "0 blockers",
    "0 vulnerabilities",
    "typecheck",
    "TypeScript typecheck passed",
    "release readiness doc gate passed",
    "885 tests",
    "882 pass",
    "3 skipped",
    "source-only scripts 0",
    "residue hits 0",
    "memory:evolve",
    "Historical Documents",
    "docs/governance-migration-plan.md",
    "docs/memory-v2-alignment-implementation-checklist-2026-06-09.md",
    "docs/superpowers/plans/2026-06-10-memory-v2-final-migration-checklist.md",
  ]) {
    assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), required);
  }

  assert.doesNotMatch(doc, /MEMORY_V2_|\/api\/memory\/v2|sk-|真实token/u);
});

test("historical migration plans are explicitly marked and open-source safe", () => {
  const releaseReadinessDoc = readFileSync(path.join(process.cwd(), DOC_PATH), "utf8");
  const historicalDocs = historicalPlanDocs();

  const missingHistoricalMarker: string[] = [];
  const missingReleaseInventory: string[] = [];
  const weakReleaseInventory: string[] = [];
  const privatePathResidue: string[] = [];
  for (const file of historicalDocs) {
    const doc = readFileSync(path.join(process.cwd(), file), "utf8");
    const firstLines = doc.split(/\r?\n/u).slice(0, 8).join("\n");
    if (!/(historical|superseded|历史|已完成|已取代)/iu.test(firstLines)) {
      missingHistoricalMarker.push(file);
    }
    const inventoryLine = releaseReadinessDoc.split(/\r?\n/u).find((line) => line.includes(file));
    if (!inventoryLine) {
      missingReleaseInventory.push(file);
    } else if (!/(historical|superseded|历史|已取代|traceability)/iu.test(inventoryLine)) {
      weakReleaseInventory.push(file);
    }
    if (/\/home\/xiaoxiao\/services\//u.test(doc)) {
      privatePathResidue.push(file);
    }
  }

  assert.deepEqual(missingHistoricalMarker, []);
  assert.deepEqual(missingReleaseInventory, []);
  assert.deepEqual(weakReleaseInventory, []);
  assert.deepEqual(privatePathResidue, []);
});
