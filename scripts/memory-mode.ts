import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import {
  buildRuntimeProfilePlan,
  parseMemoryRuntimeProfile,
  type MemoryRuntimeProfile,
} from "../app/runtime-profiles";
import { resolveRuntimeModuleStates, type RuntimeEnv } from "../app/runtime-modules";

type MemoryModeAction = "status" | "plan" | "up" | "down";
type UnitStateReader = (service: string) => string;

function readArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function unitState(service: string): string {
  try {
    return execFileSync("systemctl", ["--user", "is-active", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "inactive";
  }
}

function systemctl(verb: "start" | "stop", services: readonly string[]): void {
  if (services.length === 0) return;
  execFileSync("systemctl", ["--user", verb, ...services], { stdio: "inherit" });
}

export function buildRuntimeProfileStartServices(
  mode: MemoryRuntimeProfile,
  env: RuntimeEnv = process.env
): readonly string[] {
  const plan = buildRuntimeProfilePlan(mode);
  const states = new Map(resolveRuntimeModuleStates(mode, env).map((resolved) => [resolved.module.name, resolved]));
  return [...plan.required_components, ...plan.expected_components]
  .filter((component) =>
    component.startable &&
    component.service &&
    component.kind !== "external" &&
    states.get(component.name)?.enabled !== false
  )
  .map((component) => component.service!);
}

export function buildRuntimeProfileStopServices(
  mode: MemoryRuntimeProfile,
  _env: RuntimeEnv = process.env
): readonly string[] {
  const plan = buildRuntimeProfilePlan(mode);
  return [...plan.required_components, ...plan.expected_components, ...plan.optional_components]
  .filter((component) => component.stop_with_profile && component.service)
  .map((component) => component.service!);
}

export function buildMemoryModeStatusPayload(
  action: MemoryModeAction,
  mode: MemoryRuntimeProfile,
  options: {
    readonly env?: RuntimeEnv;
    readonly unitState?: UnitStateReader;
  } = {}
): {
  readonly ok: true;
  readonly action: MemoryModeAction;
  readonly mode: MemoryRuntimeProfile;
  readonly profile_plan: ReturnType<typeof buildRuntimeProfilePlan>;
  readonly start_services: readonly string[];
  readonly stop_services: readonly string[];
  readonly services: readonly { readonly service: string; readonly state: string }[];
} {
  const env = options.env ?? process.env;
  const readUnitState = options.unitState ?? unitState;
  const plan = buildRuntimeProfilePlan(mode);
  const startable = buildRuntimeProfileStartServices(mode, env);
  const stoppable = buildRuntimeProfileStopServices(mode, env);
  const services = [...new Set([...startable, ...stoppable])].map((service) => ({
    service,
    state: readUnitState(service),
  }));

  return {
    ok: true,
    action,
    mode,
    profile_plan: plan,
    start_services: startable,
    stop_services: stoppable,
    services,
  };
}

export function runMemoryModeCli(argv = process.argv): void {
  const action = (argv[2] ?? "status") as MemoryModeAction;
  const requestedMode = readArg(argv, "--mode") ?? argv.find((arg) => ["core", "enhanced", "full"].includes(arg));
  const mode = parseMemoryRuntimeProfile(requestedMode);
  const startable = buildRuntimeProfileStartServices(mode);
  const stoppable = buildRuntimeProfileStopServices(mode);

  if (action === "up") {
    systemctl("start", startable);
  } else if (action === "down") {
    systemctl("stop", stoppable);
  }

  process.stdout.write(`${JSON.stringify(buildMemoryModeStatusPayload(action, mode), null, 2)}\n`);
}

if (require.main === module) {
  runMemoryModeCli();
}
