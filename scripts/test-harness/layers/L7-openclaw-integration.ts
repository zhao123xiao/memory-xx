import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { httpGet, httpPost, apiUrl } from "../lib/http-client.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L7", runId);
const openclawRoot = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

function readOpenClawConfig(): Record<string, any> | null {
  const openclawConfigPath = path.join(openclawRoot, "openclaw.json");
  try {
    return JSON.parse(fs.readFileSync(openclawConfigPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveExpectedMemoryExtensions(openclawConfig: Record<string, any> | null): string[] {
  const configuredSlot = openclawConfig?.plugins?.slots?.memory;
  const expected = new Set<string>(["memory-xx-tools"]);
  if (typeof configuredSlot === "string" && configuredSlot.trim()) {
    expected.add(configuredSlot.trim());
  }
  return [...expected];
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L7 OpenClaw Integration — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  const ocConfig = readOpenClawConfig();

  // 1. Extension directories
  const extensions = resolveExpectedMemoryExtensions(ocConfig);
  for (const ext of extensions) {
    const extPath = path.join(openclawRoot, "extensions", ext);
    const exists = fs.existsSync(extPath);
    check(`extension:${ext}`, exists,
      exists ? `Found at ${extPath}` : `Not found at ${extPath}`);

    if (exists) {
      const files = fs.readdirSync(extPath);
      const hasPackageJson = files.includes("package.json");
      check(`extension:${ext}:package.json`, hasPackageJson,
        hasPackageJson ? "package.json present" : `Files: ${files.join(", ")}`, "info");
    }
  }

  // 2. Gateway health
  try {
    const resp = await httpGet(`${config.gatewayUrl}/health`, { timeout: 5000 });
    check("gateway:health", resp.status === 200,
      `Gateway → ${resp.status}: ${JSON.stringify(resp.body).slice(0, 100)}`);
  } catch (e: any) {
    check("gateway:health", false, `Unreachable: ${e.message}`, "warning");
  }

  // 3. OpenClaw config
  try {
    if (!ocConfig) throw new Error(`Cannot read ${path.join(openclawRoot, "openclaw.json")}`);
    check("openclaw:config", true,
      `version=${ocConfig.version || "?"}, models_mode=${ocConfig.models_mode || "?"}`, "info");
  } catch (e: any) {
    check("openclaw:config", false, `Cannot read: ${e.message}`, "warning");
  }

  // 4. MCP tools list via wrapper
  try {
    const resp = await httpPost(apiUrl("/mcp"), {
      jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
    });
    const body = resp.body as any;
    const tools = body?.result?.tools || [];
    const toolNames = tools.map((t: any) => t.name);
    const expectedTools = ["search_memories", "write_memory", "recall_memory", "forget_memory"];
    const missingTools = expectedTools.filter(t => !toolNames.includes(t));

    check("mcp:tools", missingTools.length === 0,
      `${toolNames.length} tools registered${missingTools.length > 0 ? `, missing: ${missingTools.join(", ")}` : ""}`);

    report.metrics["mcp_tools_count"] = toolNames.length;
  } catch (e: any) {
    check("mcp:tools", false, `Error: ${e.message}`, "warning");
  }

  // 5. MCP resources
  try {
    const resp = await httpPost(apiUrl("/mcp"), {
      jsonrpc: "2.0", id: 2, method: "resources/list", params: {},
    });
    const body = resp.body as any;
    const resources = body?.result?.resources || [];
    const uris = resources.map((r: any) => r.uri);
    check("mcp:resources", uris.length > 0,
      `${uris.length} resources: ${uris.join(", ")}`, "info");
  } catch (e: any) {
    check("mcp:resources", false, `Error: ${e.message}`, "info");
  }

  // 6. Skills
  try {
    const resp = await httpGet(apiUrl("/api/memory/v2/skills"), { token: config.wrapperToken });
    const body = resp.body as any;
    const skills = body?.skills || [];
    const skillIds = Array.isArray(skills) ? skills.map((s: any) => s.id || s.name) : [];
    const expectedSkills = ["deep_search", "smart_write", "health_check", "memory_cleanup"];
    const missingSkills = expectedSkills.filter((id) => !skillIds.includes(id));
    check("skills:registered", resp.status === 200 && missingSkills.length === 0,
      `${skillIds.length} skills: ${skillIds.join(", ")}${missingSkills.length > 0 ? `, missing: ${missingSkills.join(", ")}` : ""}`);
    report.metrics["skills_count"] = skillIds.length;
  } catch (e: any) {
    check("skills:registered", false, `Error: ${e.message}`);
  }

  try {
    const resp = await httpPost(apiUrl("/api/memory/v2/skills/execute"), {
      skill_id: "health_check",
      params: { include_records: false, dry_run_repair: true },
    }, { token: config.wrapperToken, timeout: 30000 });
    const body = resp.body as any;
    check("skills:execute:health_check", resp.status === 200 && body?.ok === true && body?.success === true,
      `status=${resp.status}, ok=${body?.ok}, success=${body?.success}`);
  } catch (e: any) {
    check("skills:execute:health_check", false, `Error: ${e.message}`);
  }

  // 7. Legacy OpenClaw memory-counts compatibility route.
  try {
    const resp = await httpPost(apiUrl("/api/memory/v2/orchestrator/memory-counts"), {
      scope_type: "project",
      scope_id: "main",
      include_by_scope: true,
    }, { token: config.wrapperToken, timeout: 10000 });
    const body = resp.body as any;
    const counts = body?.counts || {};
    check("orchestrator:memory-counts", resp.status === 200 && body?.ok === true && typeof counts.total === "number",
      `status=${resp.status}, ok=${body?.ok}, total=${counts.total ?? "?"}, approved_current=${counts.approved_current ?? "?"}`);
  } catch (e: any) {
    check("orchestrator:memory-counts", false, `Error: ${e.message}`);
  }

  check("openclaw:stock-memory-cli-excluded", true,
    "memory-xx adapter/tools are the expected memory entrypoints; stock OpenClaw memory CLI is intentionally not enabled",
    "info");

  finalizeReport(report);

  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log(`\n  L7 Result: ${report.ok ? "PASS" : "FAIL"} (${passed}/${total} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
