import type { IntelligenceCompareObservationRow } from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import { mapIntelligenceCompareObservationRow } from "./support-row-mappers";
import type { JsonObject } from "../../shared";

export interface AppendIntelligenceCompareObservationInput {
  readonly observedAt: string;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly primaryLatencyMs: number;
  readonly fallbackLatencyMs: number;
  readonly primarySchemaValid: boolean;
  readonly fallbackSchemaValid: boolean;
  readonly memoryCountDiff: number;
  readonly confidenceDiff: number;
  readonly metadata?: JsonObject;
}

export interface IntelligenceCompareBucketSummary {
  readonly bucketStart: string;
  readonly count: number;
  readonly highDiffCount: number;
  readonly highDiffRate: number;
}

export class IntelligenceCompareObservationRepository {
  async append(
    tx: WriteTransactionContext,
    input: AppendIntelligenceCompareObservationInput
  ): Promise<IntelligenceCompareObservationRow> {
    const row: IntelligenceCompareObservationRow = {
      id: tx.nextId("intelligence_compare_observation"),
      observedAt: input.observedAt,
      primaryModel: input.primaryModel,
      fallbackModel: input.fallbackModel,
      primaryLatencyMs: Math.max(0, Math.trunc(input.primaryLatencyMs)),
      fallbackLatencyMs: Math.max(0, Math.trunc(input.fallbackLatencyMs)),
      primarySchemaValid: input.primarySchemaValid,
      fallbackSchemaValid: input.fallbackSchemaValid,
      memoryCountDiff: Math.max(0, Math.trunc(input.memoryCountDiff)),
      confidenceDiff: Math.max(0, input.confidenceDiff),
      metadata: input.metadata ?? {},
      createdAt: tx.now()
    };

    if (isInMemoryTransactionContext(tx)) {
      tx.state.intelligenceCompareObservations.push(row);
      return row;
    }

    const [created] = await tx.query(
      `
        INSERT INTO intelligence_compare_observations (
          id, observed_at, primary_model, fallback_model,
          primary_latency_ms, fallback_latency_ms,
          primary_schema_valid, fallback_schema_valid,
          memory_count_diff, confidence_diff, metadata, created_at
        )
        VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)
        RETURNING *
      `,
      [
        row.id,
        row.observedAt,
        row.primaryModel,
        row.fallbackModel,
        row.primaryLatencyMs,
        row.fallbackLatencyMs,
        row.primarySchemaValid,
        row.fallbackSchemaValid,
        row.memoryCountDiff,
        row.confidenceDiff,
        JSON.stringify(row.metadata),
        row.createdAt
      ]
    );
    return mapIntelligenceCompareObservationRow(created);
  }

  async summarize(
    tx: WriteTransactionContext,
    input: { readonly since?: string; readonly confidenceDiffThreshold?: number } = {}
  ): Promise<{ readonly count: number; readonly highDiffCount: number; readonly latestObservedAt: string | null }> {
    const threshold = input.confidenceDiffThreshold ?? 0.25;
    if (isInMemoryTransactionContext(tx)) {
      const rows = tx.state.intelligenceCompareObservations.filter((row) =>
        !input.since || row.observedAt >= input.since
      );
      return {
        count: rows.length,
        highDiffCount: rows.filter((row) =>
          row.memoryCountDiff > 0 ||
          row.confidenceDiff >= threshold ||
          row.primarySchemaValid !== row.fallbackSchemaValid
        ).length,
        latestObservedAt: rows.reduce<string | null>((latest, row) =>
          latest === null || row.observedAt > latest ? row.observedAt : latest, null),
      };
    }

    const [row] = await tx.query<{ count: string; high_diff_count: string; latest_observed_at: Date | string | null }>(
      `
        SELECT
          count(*)::int AS count,
          count(*) FILTER (
            WHERE memory_count_diff > 0
               OR confidence_diff >= $1
               OR primary_schema_valid IS DISTINCT FROM fallback_schema_valid
          )::int AS high_diff_count,
          max(observed_at) AS latest_observed_at
        FROM intelligence_compare_observations
        WHERE ($2::timestamptz IS NULL OR observed_at >= $2::timestamptz)
      `,
      [threshold, input.since ?? null]
    );
    return {
      count: Number(row?.count ?? 0),
      highDiffCount: Number(row?.high_diff_count ?? 0),
      latestObservedAt: row?.latest_observed_at ? new Date(row.latest_observed_at).toISOString() : null,
    };
  }

  async summarizeRecentBuckets(
    tx: WriteTransactionContext,
    input: {
      readonly bucketCount?: number;
      readonly bucketHours?: number;
      readonly confidenceDiffThreshold?: number;
      readonly now?: string;
    } = {}
  ): Promise<readonly IntelligenceCompareBucketSummary[]> {
    const bucketCount = Math.max(1, Math.trunc(input.bucketCount ?? 3));
    const bucketHours = Math.max(1, Math.trunc(input.bucketHours ?? 1));
    const threshold = input.confidenceDiffThreshold ?? 0.25;
    const bucketMs = bucketHours * 60 * 60 * 1000;
    const nowMs = Date.parse(input.now ?? tx.now());
    const currentBucketStartMs = Math.floor(nowMs / bucketMs) * bucketMs;
    const firstBucketStartMs = currentBucketStartMs - (bucketCount - 1) * bucketMs;
    const endExclusiveMs = currentBucketStartMs + bucketMs;
    const bucketStarts = Array.from({ length: bucketCount }, (_, index) => firstBucketStartMs + index * bucketMs);

    if (isInMemoryTransactionContext(tx)) {
      const counts = new Map<number, { count: number; highDiffCount: number }>();
      for (const row of tx.state.intelligenceCompareObservations) {
        const observedMs = Date.parse(row.observedAt);
        if (observedMs < firstBucketStartMs || observedMs >= endExclusiveMs) continue;
        const bucketStartMs = Math.floor(observedMs / bucketMs) * bucketMs;
        const current = counts.get(bucketStartMs) ?? { count: 0, highDiffCount: 0 };
        const highDiff = row.memoryCountDiff > 0 ||
          row.confidenceDiff >= threshold ||
          row.primarySchemaValid !== row.fallbackSchemaValid;
        counts.set(bucketStartMs, {
          count: current.count + 1,
          highDiffCount: current.highDiffCount + (highDiff ? 1 : 0)
        });
      }
      return bucketStarts.map((bucketStartMs) => bucketSummary(bucketStartMs, counts.get(bucketStartMs)));
    }

    const rows = await tx.query<{ bucket_index: string; count: string; high_diff_count: string }>(
      `
        SELECT
          floor(extract(epoch FROM observed_at) / $2)::bigint AS bucket_index,
          count(*)::int AS count,
          count(*) FILTER (
            WHERE memory_count_diff > 0
               OR confidence_diff >= $3
               OR primary_schema_valid IS DISTINCT FROM fallback_schema_valid
          )::int AS high_diff_count
        FROM intelligence_compare_observations
        WHERE observed_at >= $1::timestamptz
          AND observed_at < $4::timestamptz
        GROUP BY 1
      `,
      [
        new Date(firstBucketStartMs).toISOString(),
        bucketMs / 1000,
        threshold,
        new Date(endExclusiveMs).toISOString()
      ]
    );
    const counts = new Map<number, { count: number; highDiffCount: number }>();
    for (const row of rows) {
      counts.set(Number(row.bucket_index) * bucketMs, {
        count: Number(row.count),
        highDiffCount: Number(row.high_diff_count)
      });
    }
    return bucketStarts.map((bucketStartMs) => bucketSummary(bucketStartMs, counts.get(bucketStartMs)));
  }
}

function bucketSummary(
  bucketStartMs: number,
  counts: { readonly count: number; readonly highDiffCount: number } | undefined
): IntelligenceCompareBucketSummary {
  const count = counts?.count ?? 0;
  const highDiffCount = counts?.highDiffCount ?? 0;
  return {
    bucketStart: new Date(bucketStartMs).toISOString(),
    count,
    highDiffCount,
    highDiffRate: count === 0 ? 0 : highDiffCount / count
  };
}
