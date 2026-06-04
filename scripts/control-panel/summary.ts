import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { readEmbeddingManifestDirtyState } from "../../app/embedding/manifest-refresh.js";
import { readAutoApprovalRuntimeControlsSync } from "../../app/governance/auto-approval-runtime-controls.js";
import { listRouteRegistry } from "../../app/server/route-registry.js";
import { config } from "../test-harness/config.js";
import { buildDatabaseMaintenanceSummary } from "./database-maintenance.js";
import { collectRuntimeSnapshot } from "./runtime-snapshot.js";
import { autoApprovalControlDefinitions, serviceControls } from "./service-controls.js";
import { listControlPanelSettings } from "./settings.js";
import { objectValue, positiveIntValue, stringValue } from "./utils.js";

interface EmbeddingProbeResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly url: string;
  readonly model: string;
  readonly expected_dims: number | null;
  readonly dims: number | null;
  readonly latency_ms: number;
  readonly error?: string;
  readonly detail?: string;
  readonly remediation?: string;
}

const execFileAsync = promisify(execFile);

async function wrapperHealth(): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (config.wrapperToken) {
    headers.Authorization = `Bearer ${config.wrapperToken}`;
    headers["X-API-Key"] = config.wrapperToken;
  }
  const response = await fetch(`${config.wrapperUrl}/health`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  return response.json();
}

function embeddingApiBase(health: unknown): string {
  const healthObject = objectValue(health);
  const provider = objectValue(healthObject.embedding_provider);
  const configured = stringValue(provider.api_base) ||
    process.env.EMBEDDING_API_BASE?.trim() ||
    process.env.EMBEDDING_PROXY_URL?.trim() ||
    "http://127.0.0.1:5221/v1";
  return configured.replace(/\/+$/, "");
}

async function embeddingProbe(health: unknown): Promise<EmbeddingProbeResult> {
  const healthObject = objectValue(health);
  const provider = objectValue(healthObject.embedding_provider);
  const generation = objectValue(healthObject.embedding_generation);
  const activeGeneration = objectValue(generation.active_generation);
  const model = stringValue(provider.model) ||
    stringValue(activeGeneration.model) ||
    process.env.EMBEDDING_MODEL?.trim() ||
    "Qwen3-Embedding-8B";
  const expectedDims = positiveIntValue(provider.dims) ||
    positiveIntValue(activeGeneration.dims) ||
    positiveIntValue(process.env.EMBEDDING_DIMS) ||
    null;
  const url = `${embeddingApiBase(health)}/embeddings`;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.EMBEDDING_API_KEY ? { authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: `memory-xx control panel embedding probe ${randomBytes(6).toString("hex")}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({}));
    const bodyObject = objectValue(body);
    const firstData = Array.isArray(bodyObject.data) ? objectValue(bodyObject.data[0]) : {};
    const embedding = Array.isArray(firstData.embedding) ? firstData.embedding : null;
    const dims = embedding ? embedding.length : null;
    const detail = stringValue(bodyObject.detail) ||
      stringValue(bodyObject.error) ||
      stringValue(objectValue(bodyObject.error).message) ||
      (response.ok ? "" : response.statusText);
    return {
      ok: response.ok && dims !== null && (expectedDims === null || dims === expectedDims),
      status: response.status,
      url,
      model,
      expected_dims: expectedDims,
      dims,
      latency_ms: Date.now() - started,
      detail: detail || undefined,
      remediation: response.ok ? undefined : "检查 EMBEDDING_API_BASE、EMBEDDING_MODEL、EMBEDDING_DIMS、OPENAI_API_KEY 和 memory-xx-embedding-proxy.service；如使用本地 upstream manager，再显式启用并启动 memory-xx-embedding-upstream.service。",
    };
  } catch (error) {
    return {
      ok: false,
      url,
      model,
      expected_dims: expectedDims,
      dims: null,
      latency_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      remediation: "检查 EMBEDDING_API_BASE、EMBEDDING_MODEL、EMBEDDING_DIMS、OPENAI_API_KEY 和 memory-xx-embedding-proxy.service；如使用本地 upstream manager，再显式启用并启动 memory-xx-embedding-upstream.service。",
    };
  }
}

export async function buildControlPanelSummary(panelStartedAt: string): Promise<Record<string, unknown>> {
  const health = await wrapperHealth().catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  const [probe, services] = await Promise.all([
    embeddingProbe(health),
    serviceControls(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    panel_started_at: panelStartedAt,
    git_commit: await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() }).then((r) => r.stdout.trim()).catch(() => "unknown"),
    route_registry: {
      count: listRouteRegistry().length,
      conversation_routes: listRouteRegistry().filter((route) => route.label.includes("/conversation/")).map((route) => route.label),
    },
    wrapper_url: config.wrapperUrl,
    wrapper_health: health,
    embedding_probe: probe,
    service_controls: services,
    auto_approval_runtime_controls: readAutoApprovalRuntimeControlsSync(),
    auto_approval_control_definitions: autoApprovalControlDefinitions(),
    parameter_settings: listControlPanelSettings(),
    database_maintenance: await buildDatabaseMaintenanceSummary(config.dbSchema).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    runtime_snapshot: await collectRuntimeSnapshot({ persist: false, schema: config.dbSchema }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    embedding_manifest_refresh: await readEmbeddingManifestDirtyState(),
  };
}
