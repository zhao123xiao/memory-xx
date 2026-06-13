import { RUNTIME_MODULES, resolveRuntimeModuleState } from "../app/runtime-modules.js";
import { parseMemoryRuntimeProfile } from "../app/runtime-profiles.js";
import { loadDotenvIfPresent } from "./lib/runtime-env.js";

loadDotenvIfPresent(process.env.MEMORY_XX_ENV_PATH || ".env");

const moduleName = process.argv[2]?.trim();
const module = RUNTIME_MODULES.find((item) => item.name === moduleName);

if (!moduleName || !module) {
  process.stderr.write(`unknown runtime module: ${moduleName || "<empty>"}\n`);
  process.exitCode = 2;
} else {
  const state = resolveRuntimeModuleState(module, parseMemoryRuntimeProfile(), process.env);
  if (state.state === "enabled") {
    process.exitCode = 0;
  } else {
    process.stderr.write(`${module.name} unavailable: ${state.state}: ${state.reason ?? "module_disabled"}\n`);
    process.exitCode = 1;
  }
}
