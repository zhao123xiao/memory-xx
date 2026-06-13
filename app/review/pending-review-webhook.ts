export type PendingReviewWebhookStatus = "not_configured" | "below_threshold" | "sent" | "failed";

export interface PendingReviewWebhookInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly pendingTotal: number;
  readonly scopeType: string | null;
  readonly scopeId: string | null;
  readonly sampleMemoryIds: readonly string[];
  readonly fetchImpl?: typeof fetch;
}

export interface PendingReviewWebhookResult {
  readonly status: PendingReviewWebhookStatus;
  readonly threshold?: number;
  readonly httpStatus?: number;
  readonly error?: string;
}

function readThreshold(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.MEMORY_XX_REVIEW_WEBHOOK_THRESHOLD ?? "20");
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 20;
}

export async function maybeSendPendingReviewWebhook(input: PendingReviewWebhookInput): Promise<PendingReviewWebhookResult> {
  const env = input.env ?? process.env;
  const webhookUrl = env.MEMORY_XX_REVIEW_WEBHOOK_URL?.trim() ?? "";
  if (!webhookUrl) return { status: "not_configured" };

  const threshold = readThreshold(env);
  if (input.pendingTotal < threshold) return { status: "below_threshold", threshold };

  try {
    const response = await (input.fetchImpl ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "memory_xx_pending_review_backlog",
        pending_total: input.pendingTotal,
        threshold,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        sample_memory_ids: input.sampleMemoryIds,
        generated_at: new Date().toISOString(),
      }),
    });
    return response.ok
      ? { status: "sent", threshold, httpStatus: response.status }
      : { status: "failed", threshold, httpStatus: response.status };
  } catch (err) {
    return {
      status: "failed",
      threshold,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
