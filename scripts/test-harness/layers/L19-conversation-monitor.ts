import { execFileSync } from "node:child_process";

import { config } from "../config";
import { scrubSecrets } from "../lib/secret-scrubber";
import { generateRunId } from "../lib/run-id";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model";

const runId = generateRunId();
const report = createEmptyReport("L19", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical"): void {
  report.checks.push({ name, passed, detail, severity });
  console.log(`  [${passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL"}] ${name}: ${scrubSecrets(detail)}`);
}

function main(): void {
  console.log("\n" + "=".repeat(50));
  console.log("  L19 Conversation Monitor - run_id: " + runId);
  console.log("=".repeat(50) + "\n");

  try {
    const output = execFileSync("npm", ["run", "test:conversation-worker"], {
      cwd: config.projectRoot,
      env: { ...process.env, TMPDIR: "/tmp" },
      encoding: "utf8",
      timeout: 240_000,
      stdio: "pipe",
    });
    console.log(output);
    check("conversation-worker-live", true, "JSONL spool -> worker -> pending -> approve -> recall passed");
  } catch (error: any) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
    console.log(scrubSecrets(output));
    check("conversation-worker-live", false, `conversation worker failed: ${output.slice(0, 500)}`);
  }

  finalizeReport(report);
  console.log("\n@@LAYER_REPORT@@" + JSON.stringify(report) + "@@END_REPORT@@");
  const passed = report.checks.filter((item) => item.passed).length;
  console.log("\n  L19 Result: " + (report.ok ? "PASS" : "FAIL") + " (" + passed + "/" + report.checks.length + " checks passed)\n");
  process.exit(report.ok ? 0 : 1);
}

main();
