import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, envPath, validateConfig } from "../config.js";
import { validateRuntimeConfig } from "../../../app/runtime-config-validator.js";
import { generateRunId, isoNow } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L0", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L0 Static Gates — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  // 1. Typecheck
  try {
    execSync("npx tsc --noEmit", {
      cwd: config.projectRoot,
      timeout: 120000,
      stdio: "pipe",
    });
    check("typecheck", true, "tsc --noEmit passed");
  } catch (e: any) {
    const stderr = e.stderr?.toString() || e.message;
    check("typecheck", false, `tsc failed: ${stderr.slice(0, 200)}`);
  }

  // 2. Package scripts
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.projectRoot, "package.json"), "utf8"));
    const requiredScripts = ["test", "build", "start", "migrate"];
    for (const script of requiredScripts) {
      const exists = script in (pkg.scripts || {});
      check(`package-script:${script}`, exists,
        exists ? `"${script}" script defined` : `"${script}" script missing in package.json`);
    }
  } catch (e: any) {
    check("package.json", false, `Cannot read package.json: ${e.message}`);
  }

  // 3. Required env vars
  const requiredConfigs: (keyof typeof config)[] = [
    "wrapperUrl", "wrapperToken", "dbUrl", "dbSchema",
    "qdrantUrl", "qdrantCollection", "redisUrl",
  ];
  const missing = validateConfig(requiredConfigs);
  check("env-vars", missing.length === 0,
    missing.length === 0 ? "All required env vars present" : `Missing: ${missing.join(", ")}`);

  const runtimeConfig = validateRuntimeConfig(process.env);
  check("runtime-config:blockers", runtimeConfig.blockers.length === 0,
    runtimeConfig.blockers.length === 0
      ? "Runtime config has no critical issues"
      : `Critical: ${runtimeConfig.blockers.join(", ")}`);
  check("runtime-config:warnings", runtimeConfig.warnings.length === 0,
    runtimeConfig.warnings.length === 0
      ? "Runtime config has no warnings"
      : `Warnings: ${runtimeConfig.warnings.join(", ")}`,
    "warning");

  const cwdEnv = path.join(config.projectRoot, ".env");
  const expectedLocalEnv = fs.existsSync(cwdEnv) ? path.resolve(cwdEnv) : undefined;
  const envPathOk = !expectedLocalEnv || path.resolve(envPath) === expectedLocalEnv || process.env.MEMORY_V2_ENV_PATH === envPath;
  check("env-path:local-profile", envPathOk,
    `env_path=${envPath}, project_root=${config.projectRoot}, db_schema=${config.dbSchema}, qdrant_collection=${config.qdrantCollection}`);

  // 4. Secret scan in source
  const srcDir = path.join(config.projectRoot, "app");
  let secretHits = 0;
  if (fs.existsSync(srcDir)) {
    const secretPattern = /(?:password|secret|token|api_key)\s*[=:]\s*['"][A-Za-z0-9\-_.]{16,}['"]/gi;
    const scanDir = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scanDir(full); continue; }
        if (!entry.name.endsWith(".js") && !entry.name.endsWith(".ts")) continue;
        try {
          const content = fs.readFileSync(full, "utf8");
          const matches = content.match(secretPattern);
          if (matches) {
            secretHits += matches.length;
            check(`secret-scan:${path.relative(config.projectRoot, full)}`, false,
              `Found ${matches.length} potential secret(s)`, "warning");
          }
        } catch {}
      }
    };
    scanDir(srcDir);
  }
  if (secretHits === 0) {
    check("secret-scan", true, "No hardcoded secrets found in source");
  }

  // 5. No hardcoded ports/IPs in source (check for literal :5100, :6333 etc outside config)
  const hardcodedPortPattern = /(?:127\.0\.0\.1|localhost):\d{4}/g;
  let portHits = 0;
  if (fs.existsSync(srcDir)) {
    const scanForPorts = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scanForPorts(full); continue; }
        if (!entry.name.endsWith(".js") && !entry.name.endsWith(".ts")) continue;
        try {
          const content = fs.readFileSync(full, "utf8");
          // Count matches only on lines that don't reference process.env (config-backed fallbacks are OK)
          const hardLines = content.split("\n").filter(l => !l.includes("process.env"));
          const matches = hardLines.join("\n").match(hardcodedPortPattern);
          if (matches && matches.length > 2) {
            portHits++;
            check(`hardcoded-addr:${path.relative(config.projectRoot, full)}`, false,
              `${matches.length} hardcoded address(es): ${matches.slice(0, 3).join(", ")}`, "warning");
          }
        } catch {}
      }
    };
    scanForPorts(srcDir);
  }
  if (portHits === 0) {
    check("hardcoded-addr", true, "No excessive hardcoded addresses in source");
  }

  finalizeReport(report);

  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  console.log(`\n  L0 Result: ${report.ok ? "PASS" : "FAIL"} (${report.checks.filter(c => c.passed).length}/${report.checks.length} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
