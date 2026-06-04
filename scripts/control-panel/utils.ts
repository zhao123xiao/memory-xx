export function resolvePanelPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMORY_XX_CONTROL_PANEL_PORT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 5310;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5310;
}

export function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe_identifier:${value}`);
  }
  return `"${value}"`;
}

export function tableName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function safeText(raw: string | null | undefined, maxLength: number): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function positiveIntValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseKeyValueLines(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}
