import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RuntimeControlValue = boolean | number | string;

export interface RuntimeControlSettings {
  readonly version: 1;
  readonly updated_at?: string;
  readonly values: Record<string, RuntimeControlValue>;
  readonly pending_restart: Record<string, RuntimeControlValue>;
}

export const RUNTIME_CONTROL_SETTINGS_FILE = "runtime-control-settings.json";

export type RuntimeControlSettingsStateReason =
  | "loaded"
  | "missing"
  | "invalid_json"
  | "read_error";

export interface RuntimeControlSettingsState {
  readonly ok: boolean;
  readonly reason: RuntimeControlSettingsStateReason;
  readonly path: string;
  readonly settings: RuntimeControlSettings;
  readonly error?: string;
}

export function memoryXXRuntimeDir(): string {
  return process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
}

export function runtimeControlSettingsPath(): string {
  return join(memoryXXRuntimeDir(), RUNTIME_CONTROL_SETTINGS_FILE);
}

export function defaultRuntimeControlSettings(): RuntimeControlSettings {
  return {
    version: 1,
    values: {},
    pending_restart: {},
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function runtimeControlValue(value: unknown): RuntimeControlValue | undefined {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  return undefined;
}

function normalizeValueMap(value: unknown): Record<string, RuntimeControlValue> {
  const root = objectValue(value);
  const result: Record<string, RuntimeControlValue> = {};
  for (const [key, raw] of Object.entries(root)) {
    const normalized = runtimeControlValue(raw);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

export function normalizeRuntimeControlSettings(value: unknown): RuntimeControlSettings {
  const root = objectValue(value);
  return {
    version: 1,
    ...(typeof root.updated_at === "string" ? { updated_at: root.updated_at } : {}),
    values: normalizeValueMap(root.values),
    pending_restart: normalizeValueMap(root.pending_restart),
  };
}

export function readRuntimeControlSettingsSync(): RuntimeControlSettings {
  return readRuntimeControlSettingsStateSync().settings;
}

export function readRuntimeControlSettingsStateSync(): RuntimeControlSettingsState {
  const path = runtimeControlSettingsPath();
  if (!existsSync(path)) {
    return {
      ok: true,
      reason: "missing",
      path,
      settings: defaultRuntimeControlSettings(),
    };
  }

  try {
    return {
      ok: true,
      reason: "loaded",
      path,
      settings: normalizeRuntimeControlSettings(JSON.parse(readFileSync(path, "utf8")) as unknown),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: /JSON/u.test(message) || /Unexpected/u.test(message) ? "invalid_json" : "read_error",
      path,
      settings: defaultRuntimeControlSettings(),
      error: message,
    };
  }
}

export function writeRuntimeControlSettingsSync(next: RuntimeControlSettings): void {
  const file = runtimeControlSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...next, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function readRuntimeControlValueSync(
  key: string,
  options: { readonly includePendingRestart?: boolean } = {}
): RuntimeControlValue | undefined {
  const settings = readRuntimeControlSettingsSync();
  if (options.includePendingRestart && settings.pending_restart[key] !== undefined) {
    return settings.pending_restart[key];
  }
  return settings.values[key];
}

export function readRuntimeControlNumberSync(
  key: string,
  fallback: number,
  options: { readonly includePendingRestart?: boolean } = {}
): number {
  const value = readRuntimeControlValueSync(key, options);
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readRuntimeControlBooleanSync(
  key: string,
  fallback: boolean,
  options: { readonly includePendingRestart?: boolean } = {}
): boolean {
  const value = readRuntimeControlValueSync(key, options);
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

export function activatePendingRuntimeControlsSync(keys: readonly string[]): RuntimeControlSettings {
  const current = readRuntimeControlSettingsSync();
  const next: RuntimeControlSettings = {
    ...current,
    values: { ...current.values },
    pending_restart: { ...current.pending_restart },
  };
  let changed = false;
  for (const key of keys) {
    if (next.pending_restart[key] === undefined) continue;
    next.values[key] = next.pending_restart[key];
    delete next.pending_restart[key];
    changed = true;
  }
  if (changed) {
    writeRuntimeControlSettingsSync(next);
    return readRuntimeControlSettingsSync();
  }
  return current;
}
