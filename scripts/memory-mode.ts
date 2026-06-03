import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import { buildRuntimeProfilePlan, parseMemoryRuntimeProfile } from "../app/runtime-profiles";

const action = process.argv[2] ?? "status";
const requestedMode = readArg("--mode") ?? process.argv.find((arg) => ["core", "enhanced", "full"].includes(arg));
const mode = parseMemoryRuntimeProfile(requestedMode);
const plan = buildRuntimeProfilePlan(mode);

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function unitState(service: string): string {
  try {
    return execFileSync("systemctl", ["--user", "is-active", service], { encoding: "utf8" }).trim();
  } catch {
    return "inactive";
  }
}

function systemctl(verb: "start" | "stop", services: readonly string[]): void {
  if (services.length === 0) return;
  execFileSync("systemctl", ["--user", verb, ...services], { stdio: "inherit" });
}

const startable = plan.required_components
  .filter((component) => component.startable && component.service)
  .map((component) => component.service!);
const optionalForDown = plan.optional_components
  .filter((component) => component.stop_with_profile && component.service)
  .map((component) => component.service!);

if (action === "up") {
  systemctl("start", startable);
} else if (action === "down") {
  systemctl("stop", optionalForDown);
}

const services = [...new Set([...startable, ...optionalForDown])].map((service) => ({
  service,
  state: unitState(service),
}));

process.stdout.write(`${JSON.stringify({
  ok: true,
  action,
  mode,
  profile_plan: plan,
  services,
}, null, 2)}\n`);
