#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";

import { evaluateCutoverGate, type CutoverGateMetricInput } from "../app/cutover-gate";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadMetrics(): Promise<readonly CutoverGateMetricInput[] | undefined> {
  const inline = argValue("--metrics-json") ?? process.env.MEMORY_XX_CUTOVER_METRICS_JSON;
  if (inline?.trim()) return JSON.parse(inline) as CutoverGateMetricInput[];
  const file = argValue("--metrics-file") ?? process.env.MEMORY_XX_CUTOVER_METRICS_FILE;
  if (file?.trim()) return JSON.parse(await readFile(file, "utf8")) as CutoverGateMetricInput[];
  return undefined;
}

const stage = argValue("--stage") ?? process.env.MEMORY_XX_CUTOVER_STAGE ?? "m4";
const result = evaluateCutoverGate(stage, {
  metrics: await loadMetrics(),
  allowDegraded: process.argv.includes("--allow-degraded") || process.env.MEMORY_XX_CUTOVER_ALLOW_DEGRADED === "true"
});

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
