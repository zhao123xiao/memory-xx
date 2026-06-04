import { evaluateP0ProductionGate, type ProductionGateResult } from "./p0-production-gate";
import { evaluateCutoverGate, type CutoverGateMetricInput } from "./cutover-gate";
import {
  IntelligenceCompareObservationRepository,
  type WriteTransactionRunner,
  withWriteTransaction
} from "./db";

export interface P1ProductionGateDatabaseOptions {
  readonly database: WriteTransactionRunner;
  readonly compareWindowHours?: number;
  readonly compareMinSampleSize?: number;
  readonly compareConfidenceDiffThreshold?: number;
  readonly compareTrendBucketHours?: number;
  readonly compareTrendBucketCount?: number;
  readonly compareTrendMinSampleSize?: number;
  readonly compareNow?: string;
}

function parseMetricJson(value: string | undefined): readonly CutoverGateMetricInput[] | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as CutoverGateMetricInput[] : null;
  } catch {
    return null;
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function loadPolicyTrainingSignals(value: string | undefined): { blockers: string[]; warnings: string[] } {
  if (!value?.trim()) return { blockers: [], warnings: [] };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const progress = readNumber(parsed.progress_percent);
    const readiness = readNumber(parsed.production_readiness_score);
    const leakage = parsed.leakage_eval && typeof parsed.leakage_eval === "object"
      ? readNumber((parsed.leakage_eval as Record<string, unknown>).default_leakage)
      : null;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (leakage !== null && leakage > 0) blockers.push(`policy_training_default_recall_leakage:${leakage}`);
    if (progress !== null && progress < 90) warnings.push(`policy_training_progress_below_release_threshold:${progress}/90`);
    if (readiness !== null && readiness < 0.9) warnings.push(`policy_training_readiness_below_minimum:${readiness}/0.9`);
    return { blockers, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { blockers: [], warnings: [`policy_training_summary_unreadable:${message}`] };
  }
}

export function evaluateP1ProductionGate(env: NodeJS.ProcessEnv = process.env): ProductionGateResult {
  const p0 = evaluateP0ProductionGate(env);
  const warnings = [...p0.warnings];
  const blockers = [...p0.blockers];
  if (env.MEMORY_XX_STRICT_SCOPE !== "true") warnings.push("strict_scope_disabled");
  if (env.MEMORY_XX_FAST_ACK_INLINE_FALLBACK === "true") {
    blockers.push("fast_ack_inline_fallback_enabled");
  }
  for (const [name, value] of [
    ["accepted_expired_backlog", env.MEMORY_XX_ACCEPTED_EXPIRED_BACKLOG],
    ["write_ticket_processing_backlog", env.MEMORY_XX_WRITE_TICKET_PROCESSING_BACKLOG],
    ["cache_invalidation_backlog", env.MEMORY_XX_CACHE_INVALIDATION_BACKLOG],
  ] as const) {
    const parsed = Number.parseInt(value ?? "0", 10);
    if (Number.isFinite(parsed) && parsed > 0) blockers.push(`${name}:${parsed}`);
  }
  const compareHighDiffRate = Number.parseFloat(env.MEMORY_XX_INTELLIGENCE_COMPARE_HIGH_DIFF_RATE ?? "0");
  if (Number.isFinite(compareHighDiffRate) && compareHighDiffRate > 0.25) {
    const message = `intelligence_compare_high_diff_rate:${compareHighDiffRate}`;
    if (env.MEMORY_XX_P1_GATE_ALLOW_DEGRADED === "true") warnings.push(message);
    else blockers.push(message);
  }
  const metrics = parseMetricJson(env.MEMORY_XX_P1_GATE_METRICS_JSON);
  const cutover = evaluateCutoverGate(env.MEMORY_XX_P1_GATE_STAGE ?? "m4", {
    metrics: metrics ?? undefined,
    allowDegraded: env.MEMORY_XX_P1_GATE_ALLOW_DEGRADED === "true"
  });
  blockers.push(...cutover.blockers);
  warnings.push(...cutover.warnings);
  const training = loadPolicyTrainingSignals(env.MEMORY_XX_POLICY_TRAINING_SUMMARY_JSON);
  blockers.push(...training.blockers);
  warnings.push(...training.warnings);
  return {
    ok: blockers.length === 0,
    status: blockers.length > 0 ? "fail" : warnings.length > 0 ? "degraded" : "pass",
    blockers,
    warnings,
  };
}

export async function evaluateP1ProductionGateWithDatabase(
  env: NodeJS.ProcessEnv = process.env,
  options: P1ProductionGateDatabaseOptions
): Promise<ProductionGateResult> {
  const compareSignals = await loadCompareObservationSignals(options);
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  if (
    nextEnv.MEMORY_XX_INTELLIGENCE_COMPARE_HIGH_DIFF_RATE === undefined &&
    compareSignals.highDiffRate !== null
  ) {
    nextEnv.MEMORY_XX_INTELLIGENCE_COMPARE_HIGH_DIFF_RATE = String(compareSignals.highDiffRate);
  }

  const base = evaluateP1ProductionGate(nextEnv);
  const blockers = [...base.blockers, ...compareSignals.blockers];
  const warnings = [...base.warnings, ...compareSignals.warnings];
  return {
    ok: blockers.length === 0,
    status: blockers.length > 0 ? "fail" : warnings.length > 0 ? "degraded" : "pass",
    blockers,
    warnings
  };
}

async function loadCompareObservationSignals(options: P1ProductionGateDatabaseOptions): Promise<{
  readonly highDiffRate: number | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}> {
  const windowHours = options.compareWindowHours ?? 24;
  const minSampleSize = options.compareMinSampleSize ?? 20;
  const threshold = options.compareConfidenceDiffThreshold ?? 0.25;
  const nowMs = options.compareNow ? Date.parse(options.compareNow) : Date.now();
  const since = new Date(nowMs - windowHours * 60 * 60 * 1000).toISOString();
  const repository = new IntelligenceCompareObservationRepository();

  try {
    const { summary, trend } = await withWriteTransaction(options.database, async (tx) => ({
      summary: await repository.summarize(tx, {
        since,
        confidenceDiffThreshold: threshold
      }),
      trend: await repository.summarizeRecentBuckets(tx, {
        bucketHours: options.compareTrendBucketHours ?? 1,
        bucketCount: options.compareTrendBucketCount ?? 3,
        confidenceDiffThreshold: threshold,
        now: options.compareNow
      })
    }));
    if (summary.count < minSampleSize) {
      return {
        highDiffRate: null,
        blockers: [],
        warnings: [
          `intelligence_compare_observations_sample_size_below_minimum:${summary.count}/${minSampleSize}`,
          `intelligence_compare_observations_window:${windowHours}h:latest=${summary.latestObservedAt ?? "none"}:recommended=TMPDIR=/tmp npm run memory:intelligence-quality -- --compare-sample-size=20 --write-observations`,
          formatCompareTrendWarning(trend)
        ]
      };
    }
    const highDiffRate = summary.count === 0 ? 0 : summary.highDiffCount / summary.count;
    const trendMinSampleSize = options.compareTrendMinSampleSize ?? 10;
    const continuousHighDiff = trend.length > 0 &&
      trend.every((bucket) => bucket.count >= trendMinSampleSize && bucket.highDiffRate > 0.25);
    const blockers = continuousHighDiff
      ? [`intelligence_compare_continuous_high_diff:${trend.length}_buckets:max=${formatRate(Math.max(...trend.map((bucket) => bucket.highDiffRate)))}`]
      : [];
    const warnings = [];
    if (summary.highDiffCount > 0) {
      warnings.push(`intelligence_compare_observations_summary:${summary.highDiffCount}/${summary.count}`);
      warnings.push(`intelligence_compare_observations_window:${windowHours}h:latest=${summary.latestObservedAt ?? "none"}`);
    }
    if (trend.some((bucket) => bucket.highDiffCount > 0)) {
      warnings.push(formatCompareTrendWarning(trend));
    }
    return {
      highDiffRate,
      blockers,
      warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      highDiffRate: null,
      blockers: [`intelligence_compare_observations_unavailable:${message}`],
      warnings: []
    };
  }
}

function formatCompareTrendWarning(
  trend: readonly { readonly count: number; readonly highDiffCount: number; readonly highDiffRate: number }[]
): string {
  return `intelligence_compare_observations_trend:${trend
    .map((bucket) => `${bucket.highDiffCount}/${bucket.count}@${formatRate(bucket.highDiffRate)}`)
    .join(",")}`;
}

function formatRate(value: number): string {
  return value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}
