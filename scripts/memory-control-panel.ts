#!/usr/bin/env tsx
import "./test-harness/config.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
  readAutoApprovalRuntimeControlsSync,
} from "../app/governance/auto-approval-runtime-controls.js";
import { buildCodeGraphFromUrl } from "./control-panel/code-graph-builder.js";
import {
  buildConversationBatch,
  buildConversationRecent,
  buildConversationSession,
} from "./control-panel/conversation-builders.js";
import {
  buildRecallFlow,
  buildRecentFlows,
  buildWriteFlow,
} from "./control-panel/flow-builders.js";
import {
  buildGraphMemoryDetails,
  buildGraphNeighborhoodFromUrl,
  buildGraphSummary,
} from "./control-panel/graph-builders.js";
import { renderControlPanelHtml, renderFlowsHtml } from "./control-panel/renderers.js";
import { createControlPanelHandler, sendJson } from "./control-panel/routes.js";
import { buildControlPanelSummary } from "./control-panel/summary.js";
import {
  readControlPanelRuntimeSettingsSync,
} from "./control-panel/settings.js";
import {
  resolvePanelPort,
} from "./control-panel/utils.js";
import { config } from "./test-harness/config.js";

const PANEL_STARTED_AT = new Date().toISOString();

const DEFAULT_CONTROL_PANEL_SETTINGS = readControlPanelRuntimeSettingsSync();
const DEFAULT_GRAPH_SCOPE_TYPE = DEFAULT_CONTROL_PANEL_SETTINGS.graph.default_scope_type;
const DEFAULT_GRAPH_SCOPE_ID = DEFAULT_CONTROL_PANEL_SETTINGS.graph.default_scope_id;
const PANEL_TOKEN = randomBytes(24).toString("hex");

function html(): string {
  return renderControlPanelHtml({
    panelToken: PANEL_TOKEN,
    defaultGraphScopeType: DEFAULT_GRAPH_SCOPE_TYPE,
    defaultGraphScopeId: DEFAULT_GRAPH_SCOPE_ID,
    projectRoot: config.projectRoot,
    refreshIntervalMs: DEFAULT_CONTROL_PANEL_SETTINGS.panel.refresh_interval_ms,
  });
}

function flowsHtml(): string {
  return renderFlowsHtml({ panelToken: PANEL_TOKEN });
}
async function main(): Promise<void> {
  const handle = createControlPanelHandler({
    panelToken: PANEL_TOKEN,
    dbSchema: config.dbSchema,
    html,
    flowsHtml,
    buildSummary: () => buildControlPanelSummary(PANEL_STARTED_AT),
    buildRecentFlows,
    buildWriteFlow,
    buildRecallFlow,
    buildConversationRecent,
    buildConversationBatch,
    buildConversationSession,
    buildGraphSummary,
    buildGraphNeighborhood: async (url) => buildGraphNeighborhoodFromUrl(url, {
      scopeType: DEFAULT_GRAPH_SCOPE_TYPE,
      scopeId: DEFAULT_GRAPH_SCOPE_ID,
    }),
    buildGraphMemoryDetails,
    buildCodeGraphFromUrl,
    readAutoApprovalRuntimeControls: readAutoApprovalRuntimeControlsSync,
  });
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  const listenPort = resolvePanelPort();
  server.listen(listenPort, "127.0.0.1", () => {
    process.stdout.write(`memory-xx control panel: http://127.0.0.1:${listenPort}/\n`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
