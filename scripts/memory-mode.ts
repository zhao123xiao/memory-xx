import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import {
  buildRuntimeProfilePlan,
  parseMemoryRuntimeProfile,
  type MemoryRuntimeProfile,
} from "../app/runtime-profiles";

type MemoryModeAction = "status" | "plan" | "up" | "down";

function readArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
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

export function buildRuntimeProfileStartServices(mode: MemoryRuntimeProfile): readonly string[] {
  const plan = buildRuntimeProfilePlan(mode);
  return [...plan.required_components, ...plan.expected_components]
  .filter((component) => component.startable && component.service && component.kind !== "external")
  .map((component) => component.service!);
}

export function buildRuntimeProfileStopServices(mode: MemoryRuntimeProfile): readonly string[] {
  const plan = buildRuntimeProfilePlan(mode);
  return [...plan.expected_components, ...plan.optional_components]
  .filter((component) => component.stop_with_profile && component.service)
  .map((component) => component.service!);
}

export function runMemoryModeCli(argv = process.argv): void {
  const action = (argv[2] ?? "status") as MemoryModeAction;
  const requestedMode = readArg(argv, "--mode") ?? argv.find((arg) => ["core", "enhanced", "full"].includes(arg));
  const mode = parseMemoryRuntimeProfile(requestedMode);
  const plan = buildRuntimeProfilePlan(mode);
  const startable = buildRuntimeProfileStartServices(mode);
  const stoppable = buildRuntimeProfileStopServices(mode);

  if (action === "up") {
    systemctl("start", startable);
  } else if (action === "down") {
    systemctl("stop", stoppable);
  }

  const services = [...new Set([...startable, ...stoppable])].map((service) => ({
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
}

if (require.main === module) {
  runMemoryModeCli();
}
