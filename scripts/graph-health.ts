import "./test-harness/config.js";
import { getGraphHealthStatus } from "../app/graph-health";

const status = getGraphHealthStatus();
process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
process.exitCode = status.ok ? 0 : 1;
