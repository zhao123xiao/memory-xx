import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { config, envPath } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { httpGet, httpPost, apiUrl } from "../lib/http-client.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L1", runId);
const TEST_COMMAND = {
  command: "node",
  args: ["--import", "tsx", "--test", "tests/*.test.ts", "tests/coordination/*.test.ts"],
} as const;
const TEST_TIMEOUT_MS = 300_000;

export function classifyMcpToolsContractSeverity(status: number, body: unknown): CheckResult["severity"] {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return status === 401 || payload.error === "unauthorized" ? "warning" : "critical";
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function runNpmTests() {
  console.log(`  Running npm test with streaming diagnostics: ${TEST_COMMAND.command} ${TEST_COMMAND.args.join(" ")}`);
  const startedAt = Date.now();
  let output = "";
  try {
    output = await runStreamingTestCommand(`${TEST_COMMAND.command} ${TEST_COMMAND.args.join(" ")}`, TEST_TIMEOUT_MS);
    const lines = output.split("\n");
    let passed = 0, failed = 0, skipped = 0;
    for (const line of lines) {
      const pMatch = line.match(/# pass\s+(\d+)/);
      if (pMatch) passed = parseInt(pMatch[1]);
      const fMatch = line.match(/# fail\s+(\d+)/);
      if (fMatch) failed = parseInt(fMatch[1]);
      const sMatch = line.match(/# skip(?:ped)?\s+(\d+)/);
      if (sMatch) skipped = parseInt(sMatch[1]);
    }
    // Fallback parse for node test runner output
    if (passed === 0 && failed === 0) {
      passed = (output.match(/ok \d+/g) || []).length;
      failed = (output.match(/not ok \d+/g) || []).length;
    }
    report.metrics["tests_passed"] = passed;
    report.metrics["tests_failed"] = failed;
    report.metrics["tests_skipped"] = skipped;
    report.metrics["tests_duration_ms"] = Date.now() - startedAt;
    check("npm-test", failed === 0,
      `${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (skipped > 0) {
      check("npm-test-skips", true, `${skipped} tests skipped (may require Postgres)`, "info");
    }
    return failed === 0;
  } catch (e: any) {
    const failedOutput = String(e.output ?? output ?? e.message ?? "");
    const lines = failedOutput.split("\n");
    const failureLineIndexes = lines
      .map((line, index) => line.startsWith("not ok ") ? index : -1)
      .filter((index) => index >= 0);
    if (failureLineIndexes.length > 0) {
      console.log("\n  npm test failure context:");
      for (const index of failureLineIndexes.slice(0, 10)) {
        const start = Math.max(0, index - 8);
        const end = Math.min(lines.length, index + 24);
        console.log(lines.slice(start, end).join("\n"));
      }
    } else {
      const outputTail = lines.slice(-120).join("\n");
      if (outputTail) {
        console.log("\n  npm test failure output (tail):");
        console.log(outputTail);
      }
    }
    const failed = (failedOutput.match(/not ok \d+/g) || []).length;
    const passed = (failedOutput.match(/ok \d+/g) || []).length;
    report.metrics["tests_passed"] = passed;
    report.metrics["tests_failed"] = failed;
    report.metrics["tests_duration_ms"] = Date.now() - startedAt;
    check("npm-test", false, `${passed} passed, ${failed} failed`);
    return false;
  }
}

function processSnapshot(): string {
  try {
    return execFileSync("ps", ["-eo", "pid,ppid,stat,etime,command"], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    })
      .split("\n")
      .filter((line) => /node|tsx|npm|memory-xx|test/iu.test(line))
      .slice(0, 80)
      .join("\n");
  } catch (error) {
    return `无法读取进程快照（process snapshot）：${error instanceof Error ? error.message : String(error)}`;
  }
}

function activeTestFiles(output: string): string {
  const files = [...output.matchAll(/tests\/[^\s'")]+\.test\.ts/giu)]
    .map((match) => match[0])
    .slice(-20);
  return [...new Set(files)].join(", ") || "未从输出中识别到最近活跃测试文件";
}

function envFileKeys(): readonly string[] {
  try {
    return readFileSync(envPath, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function unitTestEnv(): NodeJS.ProcessEnv {
  const next = { ...process.env };
  // L1 imports test-harness config for HTTP contract checks, which loads .env
  // into this process. The unit test command should match `npm test`, so it
  // must not inherit production runtime knobs such as rate limits or Redis locks.
  for (const key of envFileKeys()) {
    delete next[key];
  }
  return next;
}

function runStreamingTestCommand(commandLine: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, {
      cwd: config.projectRoot,
      env: unitTestEnv(),
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    let settled = false;
    let lineBuffer = "";
    const append = (chunk: Buffer | string): void => {
      const text = String(chunk);
      chunks.push(text);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/u);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (
          line.startsWith("not ok ") ||
          /^# (?:fail|pass|skip|tests|duration_ms)\b/iu.test(line) ||
          /(?:ERR_|Error:|AssertionError|失败|超时)/u.test(line)
        ) {
          console.log(line);
        }
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const heartbeat = setInterval(() => {
      const output = chunks.join("");
      console.log(`  L1 node --test still running; recent files: ${activeTestFiles(output)}`);
    }, 15_000);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      const output = chunks.join("");
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          else if (!child.killed) child.kill("SIGKILL");
        } catch {
          if (!child.killed) child.kill("SIGKILL");
        }
      }, 2000).unref();
      const tail = output.split("\n").slice(-160).join("\n");
      reject(Object.assign(new Error(`L1 node --test 超时（timeout）${timeoutMs}ms`), {
        output: [
          `L1 node --test 超时（timeout）${timeoutMs}ms`,
          `最近活跃测试文件：${activeTestFiles(output)}`,
          "最近输出尾部：",
          tail,
          "疑似相关子进程：",
          processSnapshot(),
        ].join("\n"),
      }));
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      reject(Object.assign(error, { output: chunks.join("") }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      const output = chunks.join("");
      if (code === 0) {
        resolve(output);
      } else {
        reject(Object.assign(new Error(`node --test failed: code=${code}, signal=${signal ?? "none"}`), { output }));
      }
    });
  });
}

async function contractTests() {
  // Health endpoint
  try {
    const resp = await httpGet(apiUrl("/health"));
    check("contract:health", resp.status === 200,
      `GET /health → ${resp.status}`, resp.status === 401 ? "warning" : "critical");
  } catch (e: any) {
    check("contract:health", false, `Error: ${e.message}`, "warning");
  }

  // Metrics endpoint
  try {
    const resp = await httpGet(apiUrl("/metrics"));
    check("contract:metrics", resp.status === 200,
      `GET /metrics → ${resp.status}`, resp.status === 401 ? "warning" : "critical");
  } catch (e: any) {
    check("contract:metrics", false, `Error: ${e.message}`, "warning");
  }

  // MCP tools/list
  try {
    const resp = await httpPost(apiUrl("/mcp"), {
      jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
    });
    const body = resp.body as any;
    const hasTools = Array.isArray(body?.result?.tools);
    check("contract:mcp-tools", hasTools,
      hasTools ? `tools/list returned ${body.result.tools.length} tools` : `Unexpected response: ${JSON.stringify(body).slice(0, 100)}`,
      classifyMcpToolsContractSeverity(resp.status, body));
  } catch (e: any) {
    check("contract:mcp-tools", false, `Error: ${e.message}`, "warning");
  }

  // Auth required on write
  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/write"), {
      requestId: "contract-test-no-auth", content: "test",
    }, { token: "" });
    const noAuth = resp.status === 401;
    check("contract:auth-required", noAuth,
      `No-auth write → ${resp.status}`, noAuth ? "critical" : "warning");
  } catch (e: any) {
    check("contract:auth-required", false, `Error: ${e.message}`, "warning");
  }
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L1 Unit + Contract — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  await runNpmTests();
  console.log("");
  await contractTests();

  finalizeReport(report);

  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  console.log(`\n  L1 Result: ${report.ok ? "PASS" : "FAIL"} (${report.checks.filter(c => c.passed).length}/${report.checks.length} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/test-harness/layers/L1-unit-contract.ts") || entrypoint.endsWith("scripts\\test-harness\\layers\\L1-unit-contract.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
