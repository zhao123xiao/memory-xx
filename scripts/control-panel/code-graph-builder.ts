import path from "node:path";

import { buildCodeGraph, filterCodeGraph } from "../../app/code-graph.js";
import { config } from "../test-harness/config.js";
import type { PanelGraph } from "./graph-builders.js";
import { clampInt, safeText } from "./utils.js";

const MAX_CODE_GRAPH_EDGE_LIMIT = 420;

export function buildCodeGraphFromUrl(url: URL): PanelGraph {
  const root = path.resolve(url.searchParams.get("root") || config.projectRoot);
  const projectId = url.searchParams.get("projectId")?.trim() || path.basename(root) || "unknown-project";
  const maxFiles = clampInt(url.searchParams.get("maxFiles"), 500, 1, 2000);
  const limit = clampInt(url.searchParams.get("limit"), 120, 1, 400);
  const graph = filterCodeGraph(buildCodeGraph({ root, projectId, maxFiles, includeTests: true }), {
    query: safeText(url.searchParams.get("query"), 180),
    limit,
    edgeLimit: Math.min(MAX_CODE_GRAPH_EDGE_LIMIT, limit * 3),
  });
  return {
    summary: { ...graph.summary, graph_kind: "code", root, project_id: projectId, snapshot_id: graph.snapshot_id },
    nodes: graph.nodes,
    edges: graph.edges,
  };
}
