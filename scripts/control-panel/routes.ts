import type { IncomingMessage, ServerResponse } from "node:http";
import { readMemoryClientConnections } from "../../app/observability/client-connections.js";
import { readMcpToolInvocationMetrics } from "../../app/observability/mcp-tool-invocations.js";
import { buildMigrationPreflight } from "../platform/migration-preflight.js";
import { collectPlatformDoctor, type PlatformRuntimeProfile } from "../platform/platform-doctor.js";
import { runSecretAudit } from "../security/secrets-audit.js";

import { buildDatabaseMaintenanceSummary } from "./database-maintenance.js";
import { buildApprovalCapacityAdvice } from "./approval-capacity.js";
import { buildFeedbackLoopSummary } from "./feedback-loop.js";
import { recordRuntimeSettingsAudit } from "./runtime-audit.js";
import {
  loadCodeGraphProjectSnapshots,
  loadRuntimeAgentConnections,
  loadRuntimeComponentSnapshots,
  loadRuntimeToolInvocations,
  persistCodeGraphProjectSnapshot,
  persistOpsAdvisorReport,
} from "./runtime-observability-store.js";
import { collectRuntimeSnapshot, loadRuntimeSnapshotHistory } from "./runtime-snapshot.js";
import {
  buildRuntimeRegistry,
  listControlPanelSettings,
  previewRuntimeSettings,
  resetRuntimeSettings,
  restartPlan,
  updateRuntimeSetting,
  updateRuntimeSettingsBatch,
} from "./settings.js";
import {
  autoApprovalControlDefinitions,
  setAutoApprovalRuntimeControl,
  setConversationControl,
  setServiceEnabled,
} from "./service-controls.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clampInt, objectValue, safeText, stringValue } from "./utils.js";

const execFileAsync = promisify(execFile);

function runtimeProfileFromUrl(url: URL): PlatformRuntimeProfile {
  const raw = url.searchParams.get("profile") ?? "wsl-windows-gpu";
  if (raw === "linux-systemd" || raw === "wsl-windows-gpu" || raw === "windows-native" || raw === "docker-compose-local") {
    return raw;
  }
  return "wsl-windows-gpu";
}

export interface ControlPanelRouteDeps {
  readonly panelToken: string;
  readonly dbSchema: string;
  readonly html: () => string;
  readonly flowsHtml: () => string;
  readonly buildSummary: () => Promise<Record<string, unknown>>;
  readonly buildRecentFlows: (limit: number, filters: { type?: string; priority?: string; status?: string }) => Promise<Record<string, unknown>>;
  readonly buildWriteFlow: (url: URL) => Promise<Record<string, unknown>>;
  readonly buildRecallFlow: (url: URL) => Promise<Record<string, unknown>>;
  readonly buildConversationRecent: (limit: number) => Promise<Record<string, unknown>>;
  readonly buildConversationBatch: (batchId: string) => Promise<Record<string, unknown>>;
  readonly buildConversationSession: (sessionId: string) => Promise<Record<string, unknown>>;
  readonly buildGraphSummary: () => Promise<Record<string, unknown>>;
  readonly buildGraphNeighborhood: (url: URL) => Promise<unknown>;
  readonly buildGraphMemoryDetails: (memoryId: string) => Promise<Record<string, unknown>>;
  readonly buildCodeGraphFromUrl: (url: URL) => unknown;
  readonly readAutoApprovalRuntimeControls: () => unknown;
  readonly buildMemoryOsDashboard?: () => Promise<Record<string, unknown>>;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

export function sendHtml(res: ServerResponse, payload: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? objectValue(JSON.parse(raw)) : {};
}

function authorized(req: IncomingMessage, panelToken: string): boolean {
  return req.headers["x-panel-token"] === panelToken;
}

export function createControlPanelHandler(deps: ControlPanelRouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res, deps.html());
      return;
    }
    if (req.method === "GET" && url.pathname === "/flows") {
      sendHtml(res, deps.flowsHtml());
      return;
    }
    if (url.pathname.startsWith("/api/") && !authorized(req, deps.panelToken)) {
      sendJson(res, 403, { error: "无权访问控制面板 API" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/summary") {
      sendJson(res, 200, await deps.buildSummary());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      sendJson(res, 200, { ok: true, settings: listControlPanelSettings() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/registry") {
      sendJson(res, 200, { ok: true, registry: buildRuntimeRegistry() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/snapshot") {
      sendJson(res, 200, { ok: true, snapshot: await collectRuntimeSnapshot({ schema: deps.dbSchema }) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/agents") {
      sendJson(res, 200, { ok: true, agents: await loadRuntimeAgentConnections(deps.dbSchema) ?? readMemoryClientConnections() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/clients") {
      sendJson(res, 200, { ok: true, clients: readMemoryClientConnections() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/components") {
      const snapshot = await collectRuntimeSnapshot({ schema: deps.dbSchema });
      const persistedComponents = await loadRuntimeComponentSnapshots(deps.dbSchema);
      sendJson(res, 200, {
        ok: true,
        status: snapshot.status,
        components: persistedComponents ?? objectValue(snapshot.metrics).component_statuses ?? [],
        collected_at: snapshot.collected_at,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/mcp-tools") {
      sendJson(res, 200, { ok: true, mcp_tools: await loadRuntimeToolInvocations(deps.dbSchema) ?? readMcpToolInvocationMetrics() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/settings/effective") {
      sendJson(res, 200, {
        ok: true,
        effective_settings: buildRuntimeRegistry(),
        restart_plan: restartPlan(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/platform") {
      sendJson(res, 200, await collectPlatformDoctor({ profile: runtimeProfileFromUrl(url) }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/secrets-audit") {
      sendJson(res, 200, runSecretAudit());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/memory-os/evolve") {
      if (!deps.buildMemoryOsDashboard) {
        sendJson(res, 503, { ok: false, error: "memory_os_dashboard_unavailable" });
        return;
      }
      sendJson(res, 200, await deps.buildMemoryOsDashboard());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/deployment-preflight") {
      sendJson(res, 200, await buildMigrationPreflight({ profile: runtimeProfileFromUrl(url) }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/runtime/settings/verify") {
      const body = await readJsonBody(req);
      const changes = objectValue(body.changes ?? body);
      const preview = previewRuntimeSettings(changes);
      const registry = buildRuntimeRegistry();
      sendJson(res, 200, {
        ok: true,
        preview,
        verification: preview.changes.map((change) => {
          const item = registry.find((candidate) => candidate.key === change.key);
          return {
            key: change.key,
            expected: change.after,
            current_effective_value: item?.effective_value ?? null,
            effect_status: change.effect_status,
            hot_reload_verified: change.hot_reloadable ? item?.effective_value === change.after : false,
            restart_required: change.requires_restart,
            service: change.service,
          };
        }),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime/history") {
      const rawWindow = url.searchParams.get("window");
      const window = rawWindow === "1h" || rawWindow === "7d" ? rawWindow : "24h";
      sendJson(res, 200, await loadRuntimeSnapshotHistory(window, deps.dbSchema));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/settings/preview") {
      const key = stringValue(url.searchParams.get("key"));
      const value = url.searchParams.get("value");
      if (!key) throw new Error("缺少设置项 key（设置键）");
      sendJson(res, 200, { ok: true, preview: previewRuntimeSettings({ [key]: value }) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings/preview") {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, preview: previewRuntimeSettings(objectValue(body.changes ?? body)) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings/batch-update") {
      const body = await readJsonBody(req);
      const changes = objectValue(body.changes ?? body);
      const preview = previewRuntimeSettings(changes);
      const settings = updateRuntimeSettingsBatch(changes);
      await recordRuntimeSettingsAudit({ schema: deps.dbSchema, actionType: "runtime_settings_update", preview }).catch((error) => {
        console.warn("[control-panel] runtime settings audit failed", error);
      });
      sendJson(res, 200, { ok: true, settings });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings/reset") {
      const body = await readJsonBody(req);
      const keys = Array.isArray(body.keys) ? body.keys.filter((item): item is string => typeof item === "string") : [stringValue(body.key)].filter(Boolean);
      const settings = resetRuntimeSettings(keys);
      await recordRuntimeSettingsAudit({ schema: deps.dbSchema, actionType: "runtime_settings_reset", keys }).catch((error) => {
        console.warn("[control-panel] runtime settings reset audit failed", error);
      });
      sendJson(res, 200, { ok: true, settings });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/settings/restart-plan") {
      sendJson(res, 200, { ok: true, restart_plan: restartPlan() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings/update") {
      const body = await readJsonBody(req);
      const key = stringValue(body.key);
      if (!key) throw new Error("缺少设置项 key（设置键）");
      const preview = previewRuntimeSettings({ [key]: body.value });
      const settings = updateRuntimeSetting(key, body.value);
      await recordRuntimeSettingsAudit({ schema: deps.dbSchema, actionType: "runtime_settings_update", preview }).catch((error) => {
        console.warn("[control-panel] runtime setting audit failed", error);
      });
      sendJson(res, 200, { ok: true, settings });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/database/maintenance") {
      sendJson(res, 200, { ok: true, maintenance: await buildDatabaseMaintenanceSummary(deps.dbSchema) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/auto-approval/controls") {
      sendJson(res, 200, {
        ok: true,
        runtime_controls: deps.readAutoApprovalRuntimeControls(),
        controls: autoApprovalControlDefinitions(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/auto-approval/limit-advice") {
      sendJson(res, 200, { ok: true, advice: await buildApprovalCapacityAdvice() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/auto-approval/ops") {
      const result = await execFileAsync("npm", ["run", "--silent", "memory:auto-approval-ops", "--", "report", "--json"], {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      await persistOpsAdvisorReport({ schema: deps.dbSchema, advisorType: "auto_approval", report }).catch((error) => {
        console.warn("[control-panel] ops advisor persistence failed", error);
      });
      sendJson(res, 200, report);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/ops/auto-approval-advisor") {
      const result = await execFileAsync("npm", ["run", "--silent", "memory:auto-approval-ops", "--", "report", "--json"], {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      await persistOpsAdvisorReport({ schema: deps.dbSchema, advisorType: "auto_approval", report }).catch((error) => {
        console.warn("[control-panel] ops advisor persistence failed", error);
      });
      sendJson(res, 200, report);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/feedback/recent") {
      sendJson(res, 200, await buildFeedbackLoopSummary(clampInt(url.searchParams.get("limit"), 30, 1, 100)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/feedback/label") {
      const body = await readJsonBody(req);
      const args = [
        "apply",
        `--trace-id=${stringValue(body.recall_trace_id)}`,
        ...(stringValue(body.memory_id) ? [`--memory-id=${stringValue(body.memory_id)}`] : []),
        `--feedback-type=${stringValue(body.feedback_type) || "used_in_context"}`,
        ...(stringValue(body.reason) ? [`--reason=${stringValue(body.reason)}`] : []),
      ];
      const result = await execFileAsync("npm", ["run", "--silent", "memory:trace-feedback", "--", ...args], {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      sendJson(res, 200, JSON.parse(result.stdout));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auto-approval/controls/toggle") {
      const body = await readJsonBody(req);
      const group = stringValue(body.group);
      const key = stringValue(body.key);
      const enabled = body.enabled === true;
      const runtimeControls = setAutoApprovalRuntimeControl(group, key, enabled);
      sendJson(res, 200, { ok: true, runtime_controls: runtimeControls, controls: autoApprovalControlDefinitions() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/flows/recent") {
      sendJson(res, 200, await deps.buildRecentFlows(clampInt(url.searchParams.get("limit"), 30, 1, 100), {
        type: safeText(url.searchParams.get("type"), 80),
        priority: safeText(url.searchParams.get("priority"), 80),
        status: safeText(url.searchParams.get("status"), 80),
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/flows/write") {
      sendJson(res, 200, await deps.buildWriteFlow(url));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/flows/recall") {
      sendJson(res, 200, await deps.buildRecallFlow(url));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/conversation/recent") {
      sendJson(res, 200, await deps.buildConversationRecent(clampInt(url.searchParams.get("limit"), 30, 1, 100)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/conversation/batch") {
      sendJson(res, 200, await deps.buildConversationBatch(safeText(url.searchParams.get("batchId"), 220)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/conversation/session") {
      sendJson(res, 200, await deps.buildConversationSession(safeText(url.searchParams.get("sessionId"), 220)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/services/toggle") {
      const body = await readJsonBody(req);
      const unit = stringValue(body.unit);
      const enabled = body.enabled === true;
      sendJson(res, 200, { ok: true, service: await setServiceEnabled(unit, enabled) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/conversation/toggle") {
      const body = await readJsonBody(req);
      const unit = stringValue(body.unit);
      const enabled = body.enabled === true;
      sendJson(res, 200, { ok: true, service: await setConversationControl(unit, enabled) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/graph/summary") {
      sendJson(res, 200, await deps.buildGraphSummary());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/graph/neighborhood") {
      sendJson(res, 200, await deps.buildGraphNeighborhood(url));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/graph/memory/")) {
      sendJson(res, 200, await deps.buildGraphMemoryDetails(decodeURIComponent(url.pathname.slice("/api/graph/memory/".length))));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/code-graph") {
      sendJson(res, 200, deps.buildCodeGraphFromUrl(url));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/code-graph/projects") {
      const graph = deps.buildCodeGraphFromUrl(url) as Record<string, unknown>;
      const summary = objectValue(graph.summary);
      await persistCodeGraphProjectSnapshot({ schema: deps.dbSchema, summary, dryRun: true }).catch((error) => {
        console.warn("[control-panel] code graph snapshot persistence failed", error);
      });
      sendJson(res, 200, {
        ok: true,
        projects: [{
          project_id: summary.project_id ?? summary.code_graph_project_id ?? "current",
          root: summary.root ?? process.cwd(),
          code_graph_scope: summary.code_graph_scope ?? `project:${summary.project_id ?? "current"}`,
          latest_snapshot_id: summary.snapshot_id ?? null,
          file_count: summary.file_count ?? 0,
          symbol_count: summary.symbol_count ?? 0,
          edge_count: summary.edge_count ?? 0,
          generated_at: summary.generated_at ?? null,
        }],
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/code-graph/projects/") && url.pathname.endsWith("/snapshots")) {
      const projectId = decodeURIComponent(url.pathname.slice("/api/code-graph/projects/".length, -"/snapshots".length));
      const persistedSnapshots = await loadCodeGraphProjectSnapshots(deps.dbSchema, projectId);
      if (persistedSnapshots && persistedSnapshots.length > 0) {
        sendJson(res, 200, {
          ok: true,
          project_id: projectId,
          snapshots: persistedSnapshots,
        });
        return;
      }
      url.searchParams.set("projectId", projectId);
      const graph = deps.buildCodeGraphFromUrl(url) as Record<string, unknown>;
      sendJson(res, 200, {
        ok: true,
        project_id: projectId,
        snapshots: [objectValue(graph.summary)],
      });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/code-graph/projects/") && url.pathname.endsWith("/rescan-dry-run")) {
      const projectId = decodeURIComponent(url.pathname.slice("/api/code-graph/projects/".length, -"/rescan-dry-run".length));
      const body = await readJsonBody(req);
      const graphUrl = new URL(url.toString());
      graphUrl.searchParams.set("projectId", projectId);
      if (stringValue(body.root)) graphUrl.searchParams.set("root", stringValue(body.root));
      const graph = deps.buildCodeGraphFromUrl(graphUrl) as Record<string, unknown>;
      const summary = objectValue(graph.summary);
      await persistCodeGraphProjectSnapshot({ schema: deps.dbSchema, summary, dryRun: true }).catch((error) => {
        console.warn("[control-panel] code graph dry-run persistence failed", error);
      });
      sendJson(res, 200, {
        ok: true,
        dry_run: true,
        project_id: projectId,
        rescan_plan: {
          root: summary.root ?? stringValue(body.root) ?? process.cwd(),
          code_graph_scope: summary.code_graph_scope ?? `project:${projectId}`,
          next_snapshot: summary,
          writes_global: false,
          apply_supported: false,
        },
      });
      return;
    }
    sendJson(res, 404, { error: "接口不存在" });
  };
}
