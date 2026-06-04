import { FULL_STACK_CAPABILITIES, buildFullStackCapabilitySnapshot } from "../app/full-stack-capabilities.js";
import { loadDotenvIfPresent } from "./lib/runtime-env.js";

loadDotenvIfPresent(process.env.MEMORY_XX_ENV_PATH || ".env");

const capabilityName = process.argv[2]?.trim();
const capability = FULL_STACK_CAPABILITIES.find((item) => item.name === capabilityName);

if (!capabilityName || !capability) {
  process.stderr.write(`unknown full-stack capability: ${capabilityName || "<empty>"}\n`);
  process.exitCode = 2;
} else {
  const snapshot = buildFullStackCapabilitySnapshot(process.env);
  const state = snapshot.states[capability.name];
  if (state?.enabled) {
    process.exitCode = 0;
  } else {
    process.stderr.write(`${capability.name} disabled: ${capability.env_enabled ?? "capability_disabled"}=disabled\n`);
    process.exitCode = 1;
  }
}
