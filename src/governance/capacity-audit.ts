import { randomUUID } from "node:crypto";
import { createClient } from "redis";

import { loadMemoryRedisConfig } from "../../app/cache/config";
import { GovernanceRepository } from "../../app/db/repositories/governance-repository";
import { loadMemoryV2PostgresConfig } from "../../app/db/adapters/postgres-config";
import { PostgresWriteDatabase } from "../../app/db/adapters/postgres-write-database";
import { isPostgresTransactionContext, withWriteTransaction, type WriteTransactionContext } from "../../app/db/tx/write-transaction";
import { loadMemoryV2QdrantConfig } from "../../app/recall/qdrant-config";
import type { JsonObject, JsonValue } from "../../app/shared/types";

export interface CapacityThresholds {
  readonly memoryRecordsRows: number;
  readonly outboxPendingEvents: number;
  readonly writeTicketsActive: number;
  readonly qdrantCollectionPoints: number;
  readonly redisUsedMemoryRatio: number;
  readonly redisCacheKeys: number;
  readonly outboxDeadLetterEvents: number;
  readonly outboxDeadLetterMaxAttempts: number;
}

export type CapacityCheckStatus = "ok" | "warning" | "skipped" | "error";

export interface CapacityAuditCheck {
  readonly id: string;
  readonly resource: string;
  readonly metric: string;
  readonly value: number | null;
  readonly threshold: number | null;
  readonly unit: "rows" | "events" | "tickets" | "points" | "ratio" | "keys";
  readonly status: CapacityCheckStatus;
  readonly details: JsonObject;
  readonly error?: string;
}

export interface CapacityAuditAction {
  readonly id: string;
  readonly actionType: "capacity_warning";
  readonly checkId: string;
  readonly status: "reported";
}

export type CapacityAlertLevel = "info" | "warning" | "critical";
export type CapacityAlertNotificationStatus = "not_configured" | "suppressed" | "sent" | "failed";

export interface CapacityAlertEvent {
  readonly alertKey: string;
  readonly resource: string;
  readonly metric: string;
  readonly level: CapacityAlertLevel;
  readonly status: "open" | "recovered";
  readonly notificationStatus: CapacityAlertNotificationStatus;
  readonly consecutiveCount?: number;
  readonly error?: string;
}

export interface CapacityAuditResult {
  readonly ok: boolean;
  readonly mode: "report-only";
  readonly checkedAt: string;
  readonly governanceRunId: string | null;
  readonly governanceRunStatus: "success" | "partial" | "failed" | "skipped_lock_held";
  readonly thresholds: CapacityThresholds;
  readonly checks: readonly CapacityAuditCheck[];
  readonly warnings: readonly CapacityAuditCheck[];
  readonly actions: readonly CapacityAuditAction[];
  readonly alerts: readonly CapacityAlertEvent[];
  readonly errors: readonly JsonObject[];
}

export interface RunCapacityAuditOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => string;
  readonly writeActions?: boolean;
}

const DEFAULT_THRESHOLDS: CapacityThresholds = {
  memoryRecordsRows: 100_000,
  outboxPendingEvents: 1_000,
  writeTicketsActive: 5_000,
  qdrantCollectionPoints: 50_000,
  redisUsedMemoryRatio: 0.8,
  redisCacheKeys: 10_000,
  outboxDeadLetterEvents: 50,
  outboxDeadLetterMaxAttempts: 5,
};

export function loadCapacityThresholds(env: NodeJS.ProcessEnv = process.env): CapacityThresholds {
  return {
    memoryRecordsRows: readPositiveNumberEnv(env, "MEMORY_V2_CAPACITY_MEMORY_RECORDS_THRESHOLD", DEFAULT_THRESHOLDS.memoryRecordsRows),
    outboxPendingEvents: readPositiveNumberEnv(env, "MEMORY_V2_CAPACITY_OUTBOX_PENDING_THRESHOLD", DEFAULT_THRESHOLDS.outboxPendingEvents),
    writeTicketsActive: readPositiveNumberEnv(env, "MEMORY_V2_CAPACITY_WRITE_TICKETS_ACTIVE_THRESHOLD", DEFAULT_THRESHOLDS.writeTicketsActive),
    qdrantCollectionPoints: readPositiveNumberEnv(env, "MEMORY_V2_CAPACITY_QDRANT_POINTS_THRESHOLD", DEFAULT_THRESHOLDS.qdrantCollectionPoints),
    redisUsedMemoryRatio: readRatioEnv(env, "MEMORY_V2_CAPACITY_REDIS_USED_MEMORY_RATIO_THRESHOLD", DEFAULT_THRESHOLDS.redisUsedMemoryRatio),
    redisCacheKeys: readPositiveNumberEnv(env, "MEMORY_V2_CAPACITY_REDIS_CACHE_KEYS_THRESHOLD", DEFAULT_THRESHOLDS.redisCacheKeys),
    outboxDeadLetterEvents: readPositiveNumberEnv(env, "MEMORY_V2_CAPACITY_OUTBOX_DEAD_LETTER_THRESHOLD", DEFAULT_THRESHOLDS.outboxDeadLetterEvents),
    outboxDeadLetterMaxAttempts: readPositiveNumberEnv(
      env,
      "MEMORY_V2_CAPACITY_OUTBOX_DEAD_LETTER_MAX_ATTEMPTS",
      readPositiveNumberEnv(env, "MEMORY_V2_QDRANT_PROJECTOR_MAX_ATTEMPTS", DEFAULT_THRESHOLDS.outboxDeadLetterMaxAttempts)
    ),
  };
}

export async function runCapacityAudit(options: RunCapacityAuditOptions = {}): Promise<CapacityAuditResult> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date().toISOString());
  const checkedAt = clock();
  const thresholds = loadCapacityThresholds(env);
  const database = new PostgresWriteDatabase({ config: loadMemoryV2PostgresConfig(env), clock });
  const governance = new GovernanceRepository();
  let governanceRunId: string | null = null;

  try {
    const run = await withWriteTransaction(database, (tx) => governance.tryBeginRun(tx, {
      jobType: "capacity_audit",
      mode: "report-only",
      policy: "capacity-thresholds",
    }));
    governanceRunId = run.id;

    if (run.status === "skipped_lock_held") {
      return {
        ok: false,
        mode: "report-only",
        checkedAt,
        governanceRunId: run.id,
        governanceRunStatus: "skipped_lock_held",
        thresholds,
        checks: [],
        warnings: [],
        actions: [],
        alerts: [],
        errors: [{ resource: "governance_run", message: "governance lock already held" }],
      };
    }

    const checks = [
      ...await collectPostgresChecks(database, thresholds),
      await collectQdrantPointCheck(env, thresholds),
      ...await collectRedisChecks(env, thresholds),
    ];
    const alertChecks = checks.filter((check) => check.status === "warning" || check.status === "error");
    const warnings = checks.filter((check) => check.status === "warning");
    const errors = checks
      .filter((check) => check.status === "error")
      .map((check) => ({
        check_id: check.id,
        resource: check.resource,
        metric: check.metric,
        message: check.error ?? "capacity check failed",
      }));
    const actions = await withWriteTransaction(database, async (tx) => {
      const recorded: CapacityAuditAction[] = [];
      if (options.writeActions !== false) {
        for (const warning of alertChecks) {
          const action = await governance.recordAction(tx, {
            runId: run.id,
            actionType: "capacity_warning",
            selector: {
              check_id: warning.id,
              resource: warning.resource,
              metric: warning.metric,
            },
            evidence: checkToEvidence(warning, checkedAt),
            status: "reported",
            createdBy: "memory-capacity-audit",
          });
          recorded.push({
            id: action.id,
            actionType: "capacity_warning",
            checkId: warning.id,
            status: "reported",
          });
        }
      }

      await governance.finishRun(tx, run.id, errors.length > 0 ? "partial" : "success", {
        checked_at: checkedAt,
        warning_count: warnings.length,
        error_count: errors.length,
        action_count: recorded.length,
        report_only: true,
        write_actions: options.writeActions !== false,
      });
      return recorded;
    });
    const alerts = await withWriteTransaction(database, async (tx) =>
      syncCapacityAlerts(tx, alertChecks, checkedAt, env)
    );

    return {
      ok: true,
      mode: "report-only",
      checkedAt,
      governanceRunId: run.id,
      governanceRunStatus: errors.length > 0 ? "partial" : "success",
      thresholds,
      checks,
      warnings,
      actions,
      alerts,
      errors,
    };
  } catch (error) {
    const failedRunId = governanceRunId;
    if (failedRunId) {
      try {
        await withWriteTransaction(database, (tx) => governance.finishRun(
          tx,
          failedRunId,
          "failed",
          { checked_at: checkedAt, report_only: true },
          error instanceof Error ? error.message : String(error)
        ));
      } catch {
        // Preserve the primary failure for the caller.
      }
    }
    throw error;
  } finally {
    await database.close();
  }
}

async function collectPostgresChecks(
  database: PostgresWriteDatabase,
  thresholds: CapacityThresholds
): Promise<readonly CapacityAuditCheck[]> {
  const [row] = await withWriteTransaction(database, (tx) => {
    if (!isPostgresTransactionContext(tx)) {
      throw new Error("capacity_audit_requires_postgres_transaction");
    }
    return tx.query<{
      memory_records_rows: number | string;
      outbox_pending_events: number | string;
      write_tickets_active: number | string;
      outbox_dead_letter_events: number | string;
    }>(
      `
        SELECT
          (SELECT count(*)::int FROM memory_records) AS memory_records_rows,
          (SELECT count(*)::int FROM outbox_events WHERE dispatch_status = 'pending') AS outbox_pending_events,
          (SELECT count(*)::int FROM write_tickets WHERE terminal_at IS NULL) AS write_tickets_active,
          (
            SELECT count(*)::int
            FROM outbox_events
            WHERE dispatch_status = 'failed'
              AND attempts >= $1
          ) AS outbox_dead_letter_events
      `,
      [thresholds.outboxDeadLetterMaxAttempts]
    );
  });

  if (!row) {
    throw new Error("capacity_audit_postgres_counts_empty");
  }

  return [
    thresholdCheck({
      id: "pg_memory_records_rows",
      resource: "pg.memory_records",
      metric: "rows",
      value: toNumber(row.memory_records_rows),
      threshold: thresholds.memoryRecordsRows,
      unit: "rows",
    }),
    thresholdCheck({
      id: "pg_outbox_events_pending",
      resource: "pg.outbox_events",
      metric: "pending_events",
      value: toNumber(row.outbox_pending_events),
      threshold: thresholds.outboxPendingEvents,
      unit: "events",
    }),
    thresholdCheck({
      id: "pg_write_tickets_active",
      resource: "pg.write_tickets",
      metric: "active_tickets",
      value: toNumber(row.write_tickets_active),
      threshold: thresholds.writeTicketsActive,
      unit: "tickets",
      details: { active_definition: "terminal_at IS NULL" },
    }),
    thresholdCheck({
      id: "outbox_dead_letter_events",
      resource: "pg.outbox_events",
      metric: "dead_letter_events",
      value: toNumber(row.outbox_dead_letter_events),
      threshold: thresholds.outboxDeadLetterEvents,
      unit: "events",
      details: {
        dead_letter_definition: "dispatch_status = failed AND attempts >= max_attempts",
        max_attempts: thresholds.outboxDeadLetterMaxAttempts,
      },
    }),
  ];
}

async function collectQdrantPointCheck(
  env: NodeJS.ProcessEnv,
  thresholds: CapacityThresholds
): Promise<CapacityAuditCheck> {
  const config = loadMemoryV2QdrantConfig(env);
  if (!config.enabled || !config.base_url || !config.collection_name) {
    return skippedCheck({
      id: "qdrant_collection_points",
      resource: "qdrant.collection",
      metric: "points",
      threshold: thresholds.qdrantCollectionPoints,
      unit: "points",
      details: { reason: "qdrant_not_configured" },
    });
  }

  try {
    const response = await fetch(
      `${config.base_url.replace(/\/+$/, "")}/collections/${encodeURIComponent(config.collection_name)}/points/count`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.api_key ? { "api-key": config.api_key } : {}),
        },
        body: JSON.stringify({ exact: true }),
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!response.ok) {
      throw new Error(`qdrant_count_failed:${response.status}:${(await response.text()).slice(0, 200)}`);
    }
    const body = await response.json() as { result?: { count?: unknown } };
    const value = toNumber(body.result?.count);
    return thresholdCheck({
      id: "qdrant_collection_points",
      resource: "qdrant.collection",
      metric: "points",
      value,
      threshold: thresholds.qdrantCollectionPoints,
      unit: "points",
      details: { collection_name: config.collection_name },
    });
  } catch (error) {
    return errorCheck({
      id: "qdrant_collection_points",
      resource: "qdrant.collection",
      metric: "points",
      threshold: thresholds.qdrantCollectionPoints,
      unit: "points",
      details: { collection_name: config.collection_name },
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function collectRedisChecks(
  env: NodeJS.ProcessEnv,
  thresholds: CapacityThresholds
): Promise<readonly CapacityAuditCheck[]> {
  const baseConfig = loadMemoryRedisConfig(env);
  const config = {
    ...baseConfig,
    prefix: env.MEMORY_V2_REDIS_PREFIX?.trim() || env.MEMORY_V2_CACHE_KEY_PREFIX?.trim() || baseConfig.prefix,
  };

  if (!config.url) {
    return [
      skippedCheck({
        id: "redis_used_memory_ratio",
        resource: "redis.memory",
        metric: "used_memory_ratio",
        threshold: thresholds.redisUsedMemoryRatio,
        unit: "ratio",
        details: { reason: "redis_not_configured" },
      }),
      skippedCheck({
        id: "redis_cache_keys",
        resource: "redis.keys",
        metric: "cache_keys",
        threshold: thresholds.redisCacheKeys,
        unit: "keys",
        details: { reason: "redis_not_configured", pattern: `${config.prefix}:cache:*` },
      }),
    ];
  }

  const client = createClient({
    url: config.url,
    socket: {
      connectTimeout: config.connect_timeout_ms,
      reconnectStrategy: false,
    },
  });

  try {
    await client.connect();
    const infoRaw = await client.sendCommand(["INFO", "memory"]);
    const info = parseRedisInfo(String(infoRaw));
    const usedMemoryBytes = readOptionalNumber(info.used_memory);
    let maxMemoryBytes = readOptionalNumber(info.maxmemory);
    if (!maxMemoryBytes || maxMemoryBytes <= 0) {
      maxMemoryBytes = await readRedisMaxmemoryConfig(client);
    }

    const memoryCheck = usedMemoryBytes !== null && maxMemoryBytes !== null && maxMemoryBytes > 0
      ? thresholdCheck({
        id: "redis_used_memory_ratio",
        resource: "redis.memory",
        metric: "used_memory_ratio",
        value: usedMemoryBytes / maxMemoryBytes,
        threshold: thresholds.redisUsedMemoryRatio,
        unit: "ratio",
        details: {
          used_memory_bytes: usedMemoryBytes,
          maxmemory_bytes: maxMemoryBytes,
          used_memory_percent: roundRatio((usedMemoryBytes / maxMemoryBytes) * 100),
        },
      })
      : skippedCheck({
        id: "redis_used_memory_ratio",
        resource: "redis.memory",
        metric: "used_memory_ratio",
        threshold: thresholds.redisUsedMemoryRatio,
        unit: "ratio",
        details: {
          reason: "redis_maxmemory_not_configured",
          used_memory_bytes: usedMemoryBytes,
          maxmemory_bytes: maxMemoryBytes,
        },
      });

    const keyPattern = `${config.prefix}:cache:*`;
    const cacheKeyCount = await countRedisKeys(client, keyPattern);
    const keyCheck = thresholdCheck({
      id: "redis_cache_keys",
      resource: "redis.keys",
      metric: "cache_keys",
      value: cacheKeyCount,
      threshold: thresholds.redisCacheKeys,
      unit: "keys",
      details: { pattern: keyPattern },
    });

    return [memoryCheck, keyCheck];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      errorCheck({
        id: "redis_used_memory_ratio",
        resource: "redis.memory",
        metric: "used_memory_ratio",
        threshold: thresholds.redisUsedMemoryRatio,
        unit: "ratio",
        details: {},
        error: message,
      }),
      errorCheck({
        id: "redis_cache_keys",
        resource: "redis.keys",
        metric: "cache_keys",
        threshold: thresholds.redisCacheKeys,
        unit: "keys",
        details: { pattern: `${config.prefix}:cache:*` },
        error: message,
      }),
    ];
  } finally {
    try {
      if (client.isOpen) {
        await client.quit();
      }
    } catch {
      // Nothing useful to do after the audit result has already been produced.
    }
  }
}

function thresholdCheck(input: {
  readonly id: string;
  readonly resource: string;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  readonly unit: CapacityAuditCheck["unit"];
  readonly details?: JsonObject;
}): CapacityAuditCheck {
  return {
    id: input.id,
    resource: input.resource,
    metric: input.metric,
    value: input.value,
    threshold: input.threshold,
    unit: input.unit,
    status: input.value > input.threshold ? "warning" : "ok",
    details: input.details ?? {},
  };
}

function skippedCheck(input: {
  readonly id: string;
  readonly resource: string;
  readonly metric: string;
  readonly threshold: number;
  readonly unit: CapacityAuditCheck["unit"];
  readonly details: JsonObject;
}): CapacityAuditCheck {
  return {
    id: input.id,
    resource: input.resource,
    metric: input.metric,
    value: null,
    threshold: input.threshold,
    unit: input.unit,
    status: "skipped",
    details: input.details,
  };
}

function errorCheck(input: {
  readonly id: string;
  readonly resource: string;
  readonly metric: string;
  readonly threshold: number;
  readonly unit: CapacityAuditCheck["unit"];
  readonly details: JsonObject;
  readonly error: string;
}): CapacityAuditCheck {
  return {
    id: input.id,
    resource: input.resource,
    metric: input.metric,
    value: null,
    threshold: input.threshold,
    unit: input.unit,
    status: "error",
    details: input.details,
    error: input.error,
  };
}

function checkToEvidence(check: CapacityAuditCheck, checkedAt: string): JsonObject {
  return {
    checked_at: checkedAt,
    check_id: check.id,
    resource: check.resource,
    metric: check.metric,
    value: check.value,
    threshold: check.threshold,
    unit: check.unit,
    comparison: ">",
    status: check.status,
    details: check.details,
  };
}

async function syncCapacityAlerts(
  tx: WriteTransactionContext,
  activeChecks: readonly CapacityAuditCheck[],
  checkedAt: string,
  env: NodeJS.ProcessEnv
): Promise<readonly CapacityAlertEvent[]> {
  if (!isPostgresTransactionContext(tx)) return [];
  const webhookUrl = env.MEMORY_V2_ALERT_WEBHOOK_URL?.trim() || env.CAPACITY_ALERT_WEBHOOK_URL?.trim() || "";
  const activeKeys = new Set(activeChecks.map(alertKeyForCheck));
  const events: CapacityAlertEvent[] = [];

  for (const check of activeChecks) {
    const alertKey = alertKeyForCheck(check);
    const level = alertLevelForCheck(check);
    const existing = await loadAlert(tx, alertKey);
    const previousPayload = readJsonObject(existing?.payload) ?? {};
    const previousCount = Number(previousPayload.consecutive_count ?? 0);
    const consecutiveCount = existing?.status === "open" ? previousCount + 1 : 1;
    const payload = {
      ...checkToEvidence(check, checkedAt),
      level,
      consecutive_count: consecutiveCount,
    } as JsonObject;
    const firstSeenAt = existing?.status === "open" ? existing.first_seen_at : checkedAt;

    if (existing) {
      await tx.query(
        `
          UPDATE memory_alerts
          SET resource = $2,
              metric = $3,
              level = $4,
              value = $5,
              threshold = $6,
              status = 'open',
              first_seen_at = $7::timestamptz,
              last_seen_at = $8::timestamptz,
              recovered_at = NULL,
              payload = $9::jsonb
          WHERE alert_key = $1
        `,
        [
          alertKey,
          check.resource,
          check.metric,
          level,
          check.value,
          check.threshold,
          firstSeenAt,
          checkedAt,
          JSON.stringify(payload),
        ]
      );
    } else {
      await tx.query(
        `
          INSERT INTO memory_alerts (
            id, alert_key, resource, metric, level, value, threshold, status,
            first_seen_at, last_seen_at, payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8::timestamptz, $8::timestamptz, $9::jsonb)
        `,
        [
          randomUUID(),
          alertKey,
          check.resource,
          check.metric,
          level,
          check.value,
          check.threshold,
          checkedAt,
          JSON.stringify(payload),
        ]
      );
    }

    const shouldSend = shouldSendOpenAlert(existing?.last_sent_at ?? null, checkedAt, level, consecutiveCount, webhookUrl);
    const notification = shouldSend
      ? await sendFeishuAlert(webhookUrl, buildOpenFeishuCard(check, level))
      : { status: webhookUrl ? "suppressed" as const : "not_configured" as const };
    if (notification.status === "sent") {
      await markAlertSent(tx, alertKey, checkedAt);
    }
    events.push({
      alertKey,
      resource: check.resource,
      metric: check.metric,
      level,
      status: "open",
      notificationStatus: notification.status,
      consecutiveCount,
      error: "error" in notification ? notification.error : undefined,
    });
  }

  const openAlerts = await tx.query<{
    alert_key: string;
    resource: string;
    metric: string;
    level: CapacityAlertLevel;
    last_sent_at: Date | string | null;
    payload: JsonObject;
  }>(
    `
      SELECT alert_key, resource, metric, level, last_sent_at, payload
      FROM memory_alerts
      WHERE status = 'open'
      FOR UPDATE
    `
  );
  for (const alert of openAlerts) {
    if (activeKeys.has(alert.alert_key)) continue;
    await tx.query(
      `
        UPDATE memory_alerts
        SET status = 'recovered',
            recovered_at = $2::timestamptz,
            last_seen_at = $2::timestamptz
        WHERE alert_key = $1
      `,
      [alert.alert_key, checkedAt]
    );
    const notification = webhookUrl && alert.last_sent_at
      ? await sendFeishuAlert(webhookUrl, buildRecoveredFeishuCard(alert))
      : { status: webhookUrl ? "suppressed" as const : "not_configured" as const };
    if (notification.status === "sent") {
      await markAlertSent(tx, alert.alert_key, checkedAt);
    }
    events.push({
      alertKey: alert.alert_key,
      resource: alert.resource,
      metric: alert.metric,
      level: alert.level,
      status: "recovered",
      notificationStatus: notification.status,
      error: "error" in notification ? notification.error : undefined,
    });
  }

  return events;
}

async function loadAlert(
  tx: WriteTransactionContext,
  alertKey: string
): Promise<{
  readonly alert_key: string;
  readonly status: string;
  readonly first_seen_at: Date | string;
  readonly last_sent_at: Date | string | null;
  readonly payload: JsonObject;
} | null> {
  if (!isPostgresTransactionContext(tx)) return null;
  const rows = await tx.query<{
    alert_key: string;
    status: string;
    first_seen_at: Date | string;
    last_sent_at: Date | string | null;
    payload: JsonObject;
  }>(
    `SELECT alert_key, status, first_seen_at, last_sent_at, payload FROM memory_alerts WHERE alert_key = $1 FOR UPDATE`,
    [alertKey]
  );
  return rows[0] ?? null;
}

async function markAlertSent(
  tx: WriteTransactionContext,
  alertKey: string,
  sentAt: string
): Promise<void> {
  if (!isPostgresTransactionContext(tx)) return;
  await tx.query(`UPDATE memory_alerts SET last_sent_at = $2::timestamptz WHERE alert_key = $1`, [alertKey, sentAt]);
}

function alertKeyForCheck(check: CapacityAuditCheck): string {
  return `${check.resource}:${check.metric}`;
}

function alertLevelForCheck(check: CapacityAuditCheck): CapacityAlertLevel {
  if (check.status === "error") return "critical";
  if (check.value !== null && check.threshold !== null && check.value >= check.threshold * 2) return "critical";
  return "warning";
}

export function shouldSendOpenAlert(
  lastSentAt: Date | string | null,
  checkedAt: string,
  level: CapacityAlertLevel,
  consecutiveCount: number,
  webhookUrl: string
): boolean {
  if (!webhookUrl) return false;
  if (level !== "critical" && consecutiveCount < 2) return false;
  if (!lastSentAt) return true;
  return Date.parse(checkedAt) - Date.parse(String(lastSentAt)) >= 6 * 60 * 60 * 1000;
}

export function buildOpenFeishuCard(check: CapacityAuditCheck, level: CapacityAlertLevel): JsonObject {
  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "⚠️ memory-xx 容量告警" },
        template: "red",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: [
              `**资源**: ${check.resource}`,
              `**指标**: ${check.metric} = ${formatAlertValue(check.value)}`,
              `**阈值**: ${formatAlertValue(check.threshold)}`,
              `**级别**: ${level}`,
            ].join("\n"),
          },
        },
      ],
    },
  } as JsonObject;
}

export function buildRecoveredFeishuCard(alert: { resource: string; metric: string; level: string }): JsonObject {
  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "✅ memory-xx 容量告警已恢复" },
        template: "green",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: [
              `**资源**: ${alert.resource}`,
              `**指标**: ${alert.metric}`,
              `**原级别**: ${alert.level}`,
            ].join("\n"),
          },
        },
      ],
    },
  } as JsonObject;
}

async function sendFeishuAlert(
  webhookUrl: string,
  payload: JsonObject
): Promise<{ readonly status: "sent" | "failed"; readonly error?: string }> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { status: "failed", error: `webhook_failed:${response.status}:${(await response.text()).slice(0, 200)}` };
    }
    return { status: "sent" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

function readJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function formatAlertValue(value: number | null): string {
  if (value === null) return "N/A";
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function parseRedisInfo(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return result;
}

async function readRedisMaxmemoryConfig(client: ReturnType<typeof createClient>): Promise<number | null> {
  try {
    const raw = await client.sendCommand(["CONFIG", "GET", "maxmemory"]);
    if (!Array.isArray(raw) || raw.length < 2) return null;
    return readOptionalNumber(raw[1]);
  } catch {
    return null;
  }
}

async function countRedisKeys(client: ReturnType<typeof createClient>, pattern: string): Promise<number> {
  let cursor = "0";
  let count = 0;
  do {
    const raw = await client.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "1000"]);
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error("redis_scan_unexpected_response");
    }
    cursor = String(raw[0]);
    const keys = raw[1];
    if (!Array.isArray(keys)) {
      throw new Error("redis_scan_keys_unexpected_response");
    }
    count += keys.length;
  } while (cursor !== "0");
  return count;
}

function readPositiveNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRatioEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw.replace(/%$/, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed > 1 ? parsed / 100 : parsed;
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value: unknown): number {
  const parsed = readOptionalNumber(value);
  if (parsed === null) throw new Error(`capacity_audit_invalid_number:${String(value)}`);
  return parsed;
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

export function resultToJson(result: CapacityAuditResult): JsonValue {
  return result as unknown as JsonValue;
}
