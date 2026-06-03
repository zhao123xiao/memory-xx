import type { LLMCallResult } from "./types";
import { IntelligenceCompareObservationRepository } from "../db/repositories/intelligence-compare-observation-repository";
import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { withWriteTransaction } from "../db/tx/write-transaction";

export interface IntelligenceCompareObservation {
  readonly observed_at: string;
  readonly primary_model: string;
  readonly fallback_model: string;
  readonly primary_latency_ms: number;
  readonly fallback_latency_ms: number;
  readonly primary_schema_valid: boolean;
  readonly fallback_schema_valid: boolean;
  readonly memory_count_diff: number;
  readonly confidence_diff: number;
}

const observations: IntelligenceCompareObservation[] = [];
const MAX_OBSERVATIONS = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaValid(parsed: unknown): boolean {
  if (!isObject(parsed)) return false;
  if (typeof parsed.should_write !== "boolean") return false;
  return parsed.should_write === false || Array.isArray(parsed.memories);
}

function memoryCount(parsed: unknown): number {
  if (!isObject(parsed) || !Array.isArray(parsed.memories)) return 0;
  return parsed.memories.length;
}

function confidence(parsed: unknown): number {
  if (!isObject(parsed) || typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) return 0;
  return parsed.confidence;
}

export function recordIntelligenceCompareObservation(input: {
  readonly primary: LLMCallResult;
  readonly fallback: LLMCallResult;
}): IntelligenceCompareObservation {
  const observation: IntelligenceCompareObservation = {
    observed_at: new Date().toISOString(),
    primary_model: input.primary.model,
    fallback_model: input.fallback.model,
    primary_latency_ms: input.primary.latency_ms,
    fallback_latency_ms: input.fallback.latency_ms,
    primary_schema_valid: schemaValid(input.primary.parsed),
    fallback_schema_valid: schemaValid(input.fallback.parsed),
    memory_count_diff: Math.abs(memoryCount(input.primary.parsed) - memoryCount(input.fallback.parsed)),
    confidence_diff: Math.abs(confidence(input.primary.parsed) - confidence(input.fallback.parsed))
  };
  observations.unshift(observation);
  observations.splice(MAX_OBSERVATIONS);
  return observation;
}

export async function persistIntelligenceCompareObservation(
  database: WriteTransactionRunner,
  observation: IntelligenceCompareObservation
): Promise<void> {
  const repository = new IntelligenceCompareObservationRepository();
  await withWriteTransaction(database, async (tx) => {
    await repository.append(tx, {
      observedAt: observation.observed_at,
      primaryModel: observation.primary_model,
      fallbackModel: observation.fallback_model,
      primaryLatencyMs: observation.primary_latency_ms,
      fallbackLatencyMs: observation.fallback_latency_ms,
      primarySchemaValid: observation.primary_schema_valid,
      fallbackSchemaValid: observation.fallback_schema_valid,
      memoryCountDiff: observation.memory_count_diff,
      confidenceDiff: observation.confidence_diff
    });
  });
}

export function getIntelligenceCompareObservationSnapshot(): {
  readonly count: number;
  readonly high_diff_count: number;
  readonly latest?: IntelligenceCompareObservation;
} {
  const highDiff = observations.filter((item) =>
    item.memory_count_diff > 0 ||
    item.confidence_diff >= Number.parseFloat(process.env.MEMORY_V2_INTELLIGENCE_COMPARE_CONFIDENCE_DIFF_THRESHOLD ?? "0.25") ||
    item.primary_schema_valid !== item.fallback_schema_valid
  );
  return {
    count: observations.length,
    high_diff_count: highDiff.length,
    latest: observations[0]
  };
}

export function resetIntelligenceCompareObservationsForTest(): void {
  observations.splice(0, observations.length);
}
