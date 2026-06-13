#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface ScopeEnablement {
  readonly scope: string;
  readonly enabled: boolean;
  readonly agents: readonly string[];
  readonly allowed_sources: readonly string[];
  readonly allowed_operations: readonly string[];
  readonly confidence_threshold: number;
  readonly enabled_by: string;
  readonly enabled_at: string;
  readonly gate_report_path: string | null;
}

interface ScopeEnablementsFile {
  readonly enabled_scopes: readonly string[];
  readonly agents: readonly string[];
  readonly allowed_sources: readonly string[];
  readonly allowed_operations: readonly string[];
  readonly updated_at?: string;
  readonly enablements: readonly ScopeEnablement[];
}

const DEFAULT_AGENT = "codex";
const DEFAULT_THRESHOLD = 0.88;
const DEFAULT_ALLOWED_SOURCES = ["conversation_ingest"] as const;
const DEFAULT_ALLOWED_OPERATIONS = ["add"] as const;

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}

function runtimeDir(): string {
  return process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseThreshold(): number {
  const raw = arg("threshold");
  const parsed = raw ? Number.parseFloat(raw) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error("--threshold must be a number in (0, 1].");
  }
  return parsed;
}

function parseProjectScope(): string {
  const scope = arg("scope");
  if (scope) {
    if (!scope.startsWith("project:") || scope.length <= "project:".length) {
      throw new Error("--scope must look like project:<scope-id>.");
    }
    return scope;
  }
  const scopeId = arg("scope-id");
  if (!scopeId) throw new Error("Missing required --scope-id=<project-scope-id>.");
  if (scopeId.includes(":")) throw new Error("--scope-id must not include a scope type prefix.");
  return `project:${scopeId}`;
}

function normalizeFile(value: unknown): ScopeEnablementsFile {
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const agents = readStringArray(root.agents);
  const allowedSources = readStringArray(root.allowed_sources);
  const allowedOperations = readStringArray(root.allowed_operations);
  const enablements = Array.isArray(root.enablements)
    ? root.enablements.flatMap((item): ScopeEnablement[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const scope = typeof row.scope === "string" ? row.scope : "";
      if (!scope) return [];
      return [{
        scope,
        enabled: row.enabled !== false,
        agents: readStringArray(row.agents).length > 0 ? readStringArray(row.agents) : agents,
        allowed_sources: readStringArray(row.allowed_sources).length > 0 ? readStringArray(row.allowed_sources) : allowedSources,
        allowed_operations: readStringArray(row.allowed_operations).length > 0 ? readStringArray(row.allowed_operations) : allowedOperations,
        confidence_threshold: readNumber(row.confidence_threshold) ?? DEFAULT_THRESHOLD,
        enabled_by: typeof row.enabled_by === "string" ? row.enabled_by : "scripts/admin/enable-auto-approval",
        enabled_at: typeof row.enabled_at === "string" ? row.enabled_at : "",
        gate_report_path: typeof row.gate_report_path === "string" && row.gate_report_path ? row.gate_report_path : null,
      }];
    })
    : [];
  return {
    enabled_scopes: readStringArray(root.enabled_scopes),
    agents,
    allowed_sources: allowedSources,
    allowed_operations: allowedOperations,
    updated_at: typeof root.updated_at === "string" ? root.updated_at : undefined,
    enablements,
  };
}

async function readCurrent(file: string): Promise<ScopeEnablementsFile> {
  try {
    return normalizeFile(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch {
    return normalizeFile({});
  }
}

async function main(): Promise<void> {
  const scope = parseProjectScope();
  const agent = arg("agent") || DEFAULT_AGENT;
  const threshold = parseThreshold();
  const now = new Date().toISOString();
  const file = join(runtimeDir(), "auto-approval-scope-enablements.json");
  const current = await readCurrent(file);
  const existing = current.enablements.filter((item) => item.scope !== scope);
  const enablement: ScopeEnablement = {
    scope,
    enabled: true,
    agents: [agent],
    allowed_sources: DEFAULT_ALLOWED_SOURCES,
    allowed_operations: DEFAULT_ALLOWED_OPERATIONS,
    confidence_threshold: threshold,
    enabled_by: "scripts/admin/enable-auto-approval",
    enabled_at: now,
    gate_report_path: arg("gate-report") || null,
  };
  const enablements = [...existing, enablement];
  const enabledScopes = enablements.filter((item) => item.enabled).map((item) => item.scope);
  const next: ScopeEnablementsFile = {
    enabled_scopes: [...new Set(enabledScopes)],
    agents: [...new Set([...current.agents, agent])],
    allowed_sources: current.allowed_sources.length > 0 ? current.allowed_sources : DEFAULT_ALLOWED_SOURCES,
    allowed_operations: current.allowed_operations.length > 0 ? current.allowed_operations : DEFAULT_ALLOWED_OPERATIONS,
    updated_at: now,
    enablements,
  };

  await mkdir(runtimeDir(), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({
    ok: true,
    enabled: true,
    scope,
    agent,
    threshold,
    allowed_sources: enablement.allowed_sources,
    allowed_operations: enablement.allowed_operations,
    config: file,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
