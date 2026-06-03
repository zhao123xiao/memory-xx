import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ConversationSourceAdapter = "codex_session" | "claude_code_session" | "openclaw_session";
export type ConversationSourceRole = "user" | "assistant";

export interface ConversationSourceEvent {
  readonly id: string;
  readonly conversation_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly role: ConversationSourceRole;
  readonly content: string;
  readonly agent_id: string;
  readonly source: string;
  readonly scope_context: Record<string, unknown>;
  readonly observed_at: string;
  readonly metadata: Record<string, unknown>;
}

export interface ParseLineContext {
  readonly file: string;
  readonly offset: number;
  readonly lineNumber: number;
  readonly sessionId?: string;
}

export interface ConversationSourceConfig {
  readonly adapter: ConversationSourceAdapter;
  readonly roots: readonly string[];
}

export interface ConversationSourceCursor {
  readonly files: Record<string, number>;
}

export interface ConversationSourceScanOptions {
  readonly adapters: readonly ConversationSourceConfig[];
  readonly cursorPath: string;
  readonly readExisting?: boolean;
  readonly dryRun?: boolean;
  readonly maxFilesPerAdapter?: number;
}

export interface ConversationSourceAdapterSummary {
  readonly adapter: ConversationSourceAdapter;
  readonly roots: readonly string[];
  readonly files: number;
  readonly events: number;
  readonly skipped: number;
  readonly last_event_at: string | null;
}

export interface ConversationSourceScanResult {
  readonly events: ConversationSourceEvent[];
  readonly cursor: ConversationSourceCursor;
  readonly source_files: readonly string[];
  readonly source_adapters: readonly ConversationSourceAdapterSummary[];
  readonly source_events_posted: number;
  readonly source_skipped: number;
  readonly skipped_existing_files: number;
}

function splitRoots(value: string | undefined, fallback: readonly string[]): string[] {
  const roots = value?.trim()
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [...fallback];
  return [...new Set(roots)];
}

export function defaultConversationSourceConfigs(env: NodeJS.ProcessEnv = process.env): ConversationSourceConfig[] {
  return [
    {
      adapter: "codex_session",
      roots: splitRoots(env.MEMORY_V2_CODEX_SESSION_ROOTS, [
        "<windows-user-home>/.codex/sessions",
        "<linux-user-home>/.codex/sessions",
      ]),
    },
    {
      adapter: "claude_code_session",
      roots: splitRoots(env.MEMORY_V2_CLAUDE_SESSION_ROOTS, [
        "<windows-user-home>/.claude/projects",
        "<linux-user-home>/.claude/projects",
      ]),
    },
    {
      adapter: "openclaw_session",
      roots: splitRoots(env.MEMORY_V2_OPENCLAW_SESSION_ROOTS, [
        "<linux-user-home>/.openclaw/agents/main/sessions",
      ]),
    },
  ];
}

const DEFAULT_SCOPE_CONTEXT: Record<string, unknown> = {
  project_ids: ["memory-xx"],
  user_id: "current-instance-owner",
  workspace_id: "current-instance",
};

const ADAPTER_SOURCE: Record<ConversationSourceAdapter, string> = {
  codex_session: "codex-session-tail",
  claude_code_session: "claude-code-session-tail",
  openclaw_session: "openclaw-session-tail",
};

const ADAPTER_AGENT: Record<ConversationSourceAdapter, string> = {
  codex_session: "codex",
  claude_code_session: "claude-code",
  openclaw_session: "openclaw-main",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function basenameSessionId(file: string): string {
  return path.basename(file).replace(/\.jsonl$/u, "");
}

function normalizeObservedAt(value: unknown): string {
  const raw = readString(value);
  return raw || new Date().toISOString();
}

function sourceMessageId(raw: Record<string, unknown>, fallback: string): string {
  return readString(raw.uuid) || readString(raw.id) || readString(raw.messageId) || fallback;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!isPlainObject(item)) continue;
    const type = readString(item.type);
    if (type && type !== "text" && type !== "input_text" && type !== "output_text") continue;
    const text = readString(item.text);
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function shouldSkipContent(adapter: ConversationSourceAdapter, role: string, content: string): boolean {
  if (!content) return true;
  if (content.length > 80_000) return true;
  if (adapter === "openclaw_session") {
    if (/Memory Dreaming Promotion|short[_\s-]*term[_\s-]*promotion|__openclaw_memory_core_short_term_promotion_dream__|周度短时记忆晋升|短时记忆晋升记录/iu.test(content)) {
      return true;
    }
    if (role === "assistant" && /\[assistant turn failed before producing content\]/iu.test(content)) {
      return true;
    }
  }
  return false;
}

function makeEvent(input: {
  readonly adapter: ConversationSourceAdapter;
  readonly file: string;
  readonly offset: number;
  readonly lineNumber: number;
  readonly line: string;
  readonly role: ConversationSourceRole;
  readonly content: string;
  readonly observedAt: string;
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly cwd?: string;
}): ConversationSourceEvent {
  const lineHash = sha256(input.line);
  const sourceKey = `${input.adapter}:${input.file}:${input.offset}:${lineHash}`;
  const turnId = `${input.adapter}-${input.sourceMessageId || input.lineNumber}`;
  const conversationPrefix = input.adapter === "codex_session"
    ? "codex"
    : input.adapter === "claude_code_session"
      ? "claude"
      : "openclaw";
  return {
    id: `ce_${sha256(sourceKey).slice(0, 32)}`,
    conversation_id: `${conversationPrefix}-${input.sessionId}`,
    session_id: input.sessionId,
    turn_id: turnId,
    role: input.role,
    content: input.content,
    agent_id: ADAPTER_AGENT[input.adapter],
    source: ADAPTER_SOURCE[input.adapter],
    scope_context: { ...DEFAULT_SCOPE_CONTEXT },
    observed_at: input.observedAt,
    metadata: {
      source_adapter: input.adapter,
      source_file: input.file,
      source_offset: input.offset,
      source_line_number: input.lineNumber,
      source_line_hash: lineHash,
      source_message_id: input.sourceMessageId,
      ...(input.cwd ? { source_cwd: input.cwd } : {}),
    },
  };
}

function parseCodexLine(raw: Record<string, unknown>, line: string, context: ParseLineContext): ConversationSourceEvent | null {
  if (raw.type !== "response_item") return null;
  const payload = isPlainObject(raw.payload) ? raw.payload : {};
  if (payload.type !== "message") return null;
  const role = readString(payload.role);
  if (role !== "user" && role !== "assistant") return null;
  const content = textFromContent(payload.content);
  if (shouldSkipContent("codex_session", role, content)) return null;
  const sessionId = context.sessionId || basenameSessionId(context.file);
  return makeEvent({
    adapter: "codex_session",
    file: context.file,
    offset: context.offset,
    lineNumber: context.lineNumber,
    line,
    role,
    content,
    observedAt: normalizeObservedAt(raw.timestamp),
    sessionId,
    sourceMessageId: sourceMessageId(payload, `${context.lineNumber}`),
  });
}

function parseClaudeLine(raw: Record<string, unknown>, line: string, context: ParseLineContext): ConversationSourceEvent | null {
  const message = isPlainObject(raw.message) ? raw.message : {};
  const role = readString(message.role) || readString(raw.type);
  if (role !== "user" && role !== "assistant") return null;
  const content = textFromContent(message.content);
  if (shouldSkipContent("claude_code_session", role, content)) return null;
  const sessionId = readString(raw.sessionId) || context.sessionId || basenameSessionId(context.file);
  return makeEvent({
    adapter: "claude_code_session",
    file: context.file,
    offset: context.offset,
    lineNumber: context.lineNumber,
    line,
    role,
    content,
    observedAt: normalizeObservedAt(raw.timestamp),
    sessionId,
    sourceMessageId: sourceMessageId(raw, `${context.lineNumber}`),
    cwd: readString(raw.cwd),
  });
}

function parseOpenClawLine(raw: Record<string, unknown>, line: string, context: ParseLineContext): ConversationSourceEvent | null {
  if (raw.type !== "message") return null;
  const message = isPlainObject(raw.message) ? raw.message : {};
  const role = readString(message.role);
  if (role !== "user" && role !== "assistant") return null;
  const content = textFromContent(message.content);
  if (shouldSkipContent("openclaw_session", role, content)) return null;
  const sessionId = context.sessionId || basenameSessionId(context.file);
  return makeEvent({
    adapter: "openclaw_session",
    file: context.file,
    offset: context.offset,
    lineNumber: context.lineNumber,
    line,
    role,
    content,
    observedAt: normalizeObservedAt(raw.timestamp ?? message.timestamp),
    sessionId,
    sourceMessageId: sourceMessageId(raw, `${context.lineNumber}`),
  });
}

export function parseConversationSourceLine(
  adapter: ConversationSourceAdapter,
  line: string,
  context: ParseLineContext,
): ConversationSourceEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  switch (adapter) {
    case "codex_session":
      return parseCodexLine(raw, line, context);
    case "claude_code_session":
      return parseClaudeLine(raw, line, context);
    case "openclaw_session":
      return parseOpenClawLine(raw, line, context);
  }
}

async function loadCursor(cursorPath: string): Promise<ConversationSourceCursor> {
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as Partial<ConversationSourceCursor>;
    return { files: isPlainObject(parsed.files) ? parsed.files as Record<string, number> : {} };
  } catch {
    return { files: {} };
  }
}

async function saveCursor(cursorPath: string, cursor: ConversationSourceCursor): Promise<void> {
  await mkdir(path.dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, JSON.stringify(cursor, null, 2), "utf8");
}

function shouldIncludeFile(adapter: ConversationSourceAdapter, file: string): boolean {
  if (!file.endsWith(".jsonl")) return false;
  if (adapter === "codex_session" && file.includes(`${path.sep}archived_sessions${path.sep}`)) return false;
  if (adapter === "openclaw_session") {
    if (file.endsWith(".trajectory.jsonl")) return false;
    if (file.includes(`${path.sep}cron${path.sep}runs${path.sep}`)) return false;
  }
  return true;
}

async function listJsonlFiles(root: string, adapter: ConversationSourceAdapter, limit: number): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    const info = await stat(current).catch(() => null);
    if (!info) return;
    if (info.isFile()) {
      if (shouldIncludeFile(adapter, current)) out.push(current);
      return;
    }
    if (!info.isDirectory()) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await visit(path.join(current, entry.name));
    }
  }
  await visit(absoluteRoot);
  const withStat = await Promise.all(out.map(async (file) => ({ file, mtimeMs: (await stat(file).catch(() => null))?.mtimeMs ?? 0 })));
  return withStat.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file)).slice(0, limit).map((item) => item.file);
}

function sessionIdFromRaw(adapter: ConversationSourceAdapter, raw: Record<string, unknown>, fallback: string): string {
  if (adapter === "codex_session" && raw.type === "session_meta") {
    const payload = isPlainObject(raw.payload) ? raw.payload : {};
    return readString(payload.id) || fallback;
  }
  if (adapter === "openclaw_session" && raw.type === "session") {
    return readString(raw.id) || fallback;
  }
  if (adapter === "claude_code_session") {
    return readString(raw.sessionId) || fallback;
  }
  return fallback;
}

export async function scanConversationSources(options: ConversationSourceScanOptions): Promise<ConversationSourceScanResult> {
  const loadedCursor = await loadCursor(options.cursorPath);
  const cursor: ConversationSourceCursor = { files: { ...loadedCursor.files } };
  const events: ConversationSourceEvent[] = [];
  const sourceFiles: string[] = [];
  const summaries: ConversationSourceAdapterSummary[] = [];
  let skipped = 0;
  let skippedExistingFiles = 0;
  const maxFiles = options.maxFilesPerAdapter ?? 500;

  for (const config of options.adapters) {
    const files = (await Promise.all(config.roots.map((root) => listJsonlFiles(root, config.adapter, maxFiles))))
      .flat()
      .slice(0, maxFiles);
    let adapterEvents = 0;
    let adapterSkipped = 0;
    let lastEventAt: string | null = null;
    for (const file of files) {
      sourceFiles.push(file);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      if (cursor.files[file] === undefined && options.readExisting !== true) {
        cursor.files[file] = info.size;
        skippedExistingFiles += 1;
        continue;
      }
      const previousOffset = Math.min(cursor.files[file] ?? 0, info.size);
      if (info.size <= previousOffset) continue;
      const raw = await readFile(file);
      const chunk = raw.subarray(previousOffset).toString("utf8");
      cursor.files[file] = info.size;
      let offset = previousOffset;
      let lineNumber = 0;
      let sessionId = basenameSessionId(file);
      for (const lineWithBreak of chunk.match(/[^\n]*(?:\n|$)/gu) ?? []) {
        if (!lineWithBreak) continue;
        const line = lineWithBreak.replace(/\r?\n$/u, "");
        const lineOffset = offset;
        offset += Buffer.byteLength(lineWithBreak);
        lineNumber += 1;
        if (!line.trim()) continue;
        try {
          const rawLine = JSON.parse(line);
          if (isPlainObject(rawLine)) sessionId = sessionIdFromRaw(config.adapter, rawLine, sessionId);
        } catch {
          adapterSkipped += 1;
          skipped += 1;
          continue;
        }
        const event = parseConversationSourceLine(config.adapter, line, {
          file,
          offset: lineOffset,
          lineNumber,
          sessionId,
        });
        if (event) {
          events.push(event);
          adapterEvents += 1;
          lastEventAt = event.observed_at;
        } else {
          adapterSkipped += 1;
          skipped += 1;
        }
      }
    }
    summaries.push({
      adapter: config.adapter,
      roots: [...config.roots],
      files: files.length,
      events: adapterEvents,
      skipped: adapterSkipped,
      last_event_at: lastEventAt,
    });
  }

  if (options.dryRun !== true) await saveCursor(options.cursorPath, cursor);
  return {
    events,
    cursor,
    source_files: sourceFiles,
    source_adapters: summaries,
    source_events_posted: events.length,
    source_skipped: skipped,
    skipped_existing_files: skippedExistingFiles,
  };
}
