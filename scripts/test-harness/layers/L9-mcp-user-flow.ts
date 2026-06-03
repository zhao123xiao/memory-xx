import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { httpPost, apiUrl } from "../lib/http-client.js";
import type { CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L9", runId);
const scopeId = "mcp-user-flow-" + runId;
let memoryId = "";
let recallQuery = "";

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log("  [" + icon + "] " + name + ": " + scrubSecrets(detail));
}

function parseTool(resp: any): any {
  const text = resp?.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { return { parse_error: true, text }; }
}

async function mcpTool(name: string, args: Record<string, unknown>) {
  const resp = await httpPost(apiUrl("/mcp"), { jsonrpc: "2.0", id: Math.floor(Math.random() * 100000), method: "tools/call", params: { name, arguments: args } }, { token: config.wrapperToken, timeout: 30000 });
  return { ...resp, parsed: parseTool(resp.body as any) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idsFromRecall(parsed: any): string[] {
  const results = parsed?.recall?.results || parsed?.results || parsed?.memories || [];
  return Array.isArray(results) ? results.map((item: any) => item.memory_id || item.memoryId || item.id).filter(Boolean) : [];
}

async function cleanup() {
  if (!memoryId) return;
  try {
    const resp = await mcpTool("forget_memory", { memory_id: memoryId, mode: "tombstone" });
    report.cleanup.performed = true;
    if (resp.status === 200) report.cleanup.resources_cleaned.push(memoryId);
    else report.cleanup.failed.push(memoryId);
  } catch {
    report.cleanup.failed.push(memoryId);
  }
}

async function main() {
  console.log("\n" + "=".repeat(50));
  console.log("  L9 MCP User Flow - run_id: " + runId);
  console.log("  Scope: " + scopeId);
  console.log("=".repeat(50) + "\n");

  try {
    const toolsResp = await httpPost(apiUrl("/mcp"), { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { token: config.wrapperToken });
    const tools = (toolsResp.body as any)?.result?.tools || [];
    const names = tools.map((t: any) => t.name);
    const needed = ["smart_write_memory", "list_pending_memories", "approve_memory", "reject_memory"];
    const missing = needed.filter((name) => !names.includes(name));
    report.metrics["mcp_tools_count"] = names.length;
    check("mcp:tools", toolsResp.status === 200 && names.length >= 12 && missing.length === 0, names.length + " tools" + (missing.length ? ", missing " + missing.join(",") : ""));
  } catch (e: any) {
    check("mcp:tools", false, "Error: " + e.message);
  }

  const marker = "L9 marker " + runId;
  try {
    const sourceText = "请记住：OpenClaw 通过 MCP 使用 memory-xx 时，P4 报告要先给结论再给证据，不要写太长。测试标记 " + marker;
    const write = await mcpTool("smart_write_memory", {
      text: sourceText,
      scope_type: "project",
      scope_id: scopeId,
      agent_id: "l9-mcp-user-flow",
      mode: "write",
    });
    const created = Array.isArray(write.parsed?.created) ? write.parsed.created : [];
    const extracted = Array.isArray(write.parsed?.memories) ? write.parsed.memories : [];
    const canonical = extracted.find((item: any) => typeof item?.canonical_content === "string")?.canonical_content;
    recallQuery = typeof canonical === "string" && canonical.trim().length > 0
      ? canonical.trim().slice(0, 220)
      : "OpenClaw memory-xx MCP P4 reports conclusion before evidence";
    report.metrics["recall_query_chars"] = recallQuery.length;
    memoryId = created.find((item: any) => item?.memory_id)?.memory_id || "";
    check("smart_write_memory", write.status === 200 && !!memoryId, "status=" + write.status + " memoryId=" + memoryId + " error=" + (write.parsed?.error || ""));
  } catch (e: any) {
    check("smart_write_memory", false, "Error: " + e.message);
  }

  if (memoryId) {
    try {
      const pending = await mcpTool("list_pending_memories", { scope_type: "project", scope_id: scopeId, agent_id: "l9-mcp-user-flow", limit: 20 });
      const found = Array.isArray(pending.parsed?.memories) && pending.parsed.memories.some((m: any) => m.id === memoryId);
      check("list_pending_memories", found, "pending total=" + (pending.parsed?.total ?? "?") + " memoryId=" + memoryId);
    } catch (e: any) {
      check("list_pending_memories", false, "Error: " + e.message);
    }

    try {
      const approve = await mcpTool("approve_memory", { memory_id: memoryId, reviewer_id: "l9-mcp-user-flow", reason: "L9 test approval" });
      check("approve_memory", approve.status === 200 && approve.parsed?.ok === true, "status=" + approve.status + " lifecycle=" + approve.parsed?.lifecycle_status);
    } catch (e: any) {
      check("approve_memory", false, "Error: " + e.message);
    }

    try {
      let ids: string[] = [];
      let attempts = 0;
      for (attempts = 1; attempts <= 6; attempts += 1) {
        const recall = await mcpTool("recall_memory", { query: recallQuery, project_ids: [scopeId], memory_ids: [memoryId], limit: 10 });
        ids = idsFromRecall(recall.parsed);
        if (ids.includes(memoryId)) break;
        await sleep(2000);
      }
      check("recall_memory", ids.includes(memoryId), "attempts=" + attempts + " ids=" + ids.join(","));
    } catch (e: any) {
      check("recall_memory", false, "Error: " + e.message);
    }
  }

  await cleanup();
  check("cleanup:tombstone", !memoryId || report.cleanup.resources_cleaned.includes(memoryId), memoryId ? "cleaned " + memoryId : "no memory created");

  finalizeReport(report);
  console.log("\n@@LAYER_REPORT@@" + JSON.stringify(report) + "@@END_REPORT@@");
  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log("\n  L9 Result: " + (report.ok ? "PASS" : "FAIL") + " (" + passed + "/" + total + " checks passed)\n");
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
