import "./test-harness/config.js";
import { createMaintenanceReport } from "../app/maintenance-orchestrator";

const args = new Set(process.argv.slice(2));
const mode = args.has("--mode=auto") || args.has("auto") ? "auto" : "report";
const report = createMaintenanceReport(mode);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
