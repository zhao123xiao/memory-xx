import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MemoryEvolveRuntimeModuleId =
  | "context_hygiene"
  | "consolidation"
  | "extraction_recall_eval"
  | "policy_feedback_backprop"
  | "procedural_promotion";

export interface MemoryEvolveRuntimeControls {
  readonly version: 1;
  readonly updated_at?: string;
  readonly modules: Record<MemoryEvolveRuntimeModuleId, {
    readonly enabled: boolean;
  }>;
}

export interface MemoryEvolveRuntimeControlsReadResult {
  readonly controls: MemoryEvolveRuntimeControls;
  readonly ok: boolean;
  readonly exists: boolean;
  readonly path: string;
  readonly error?: string;
}

export const MEMORY_EVOLVE_RUNTIME_CONTROLS_FILE = "memory-evolve-runtime-controls.json";

export const MEMORY_EVOLVE_RUNTIME_MODULE_IDS: readonly MemoryEvolveRuntimeModuleId[] = [
  "context_hygiene",
  "consolidation",
  "extraction_recall_eval",
  "policy_feedback_backprop",
  "procedural_promotion",
];

export function memoryEvolveRuntimeControlsPath(): string {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
  return join(runtimeDir, MEMORY_EVOLVE_RUNTIME_CONTROLS_FILE);
}

export function defaultMemoryEvolveRuntimeControls(): MemoryEvolveRuntimeControls {
  return {
    version: 1,
    modules: {
      context_hygiene: { enabled: false },
      consolidation: { enabled: false },
      extraction_recall_eval: { enabled: false },
      policy_feedback_backprop: { enabled: false },
      procedural_promotion: { enabled: false },
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeMemoryEvolveRuntimeControls(value: unknown): MemoryEvolveRuntimeControls {
  const defaults = defaultMemoryEvolveRuntimeControls();
  const root = objectValue(value);
  const modules = objectValue(root.modules);
  return {
    version: 1,
    ...(typeof root.updated_at === "string" ? { updated_at: root.updated_at } : {}),
    modules: Object.fromEntries(
      MEMORY_EVOLVE_RUNTIME_MODULE_IDS.map((moduleId) => {
        const moduleConfig = objectValue(modules[moduleId]);
        return [moduleId, {
          enabled: boolValue(moduleConfig.enabled, defaults.modules[moduleId].enabled),
        }];
      }),
    ) as MemoryEvolveRuntimeControls["modules"],
  };
}

export function readMemoryEvolveRuntimeControlsSync(): MemoryEvolveRuntimeControls {
  return readMemoryEvolveRuntimeControlsStateSync().controls;
}

export function readMemoryEvolveRuntimeControlsStateSync(): MemoryEvolveRuntimeControlsReadResult {
  const file = memoryEvolveRuntimeControlsPath();
  if (!existsSync(file)) {
    return {
      controls: defaultMemoryEvolveRuntimeControls(),
      ok: true,
      exists: false,
      path: file,
    };
  }
  try {
    return {
      controls: normalizeMemoryEvolveRuntimeControls(JSON.parse(readFileSync(file, "utf8")) as unknown),
      ok: true,
      exists: true,
      path: file,
    };
  } catch (error) {
    return {
      controls: defaultMemoryEvolveRuntimeControls(),
      ok: false,
      exists: true,
      path: file,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeMemoryEvolveRuntimeControlsSync(next: MemoryEvolveRuntimeControls): void {
  const file = memoryEvolveRuntimeControlsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...next, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function enabledMemoryEvolveModules(
  controls = readMemoryEvolveRuntimeControlsSync(),
): Partial<Record<MemoryEvolveRuntimeModuleId, boolean>> {
  return Object.fromEntries(
    MEMORY_EVOLVE_RUNTIME_MODULE_IDS.map((moduleId) => [moduleId, controls.modules[moduleId].enabled]),
  ) as Partial<Record<MemoryEvolveRuntimeModuleId, boolean>>;
}
