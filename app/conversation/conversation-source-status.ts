import { readFile } from "node:fs/promises";
import path from "node:path";

interface HeartbeatAdapter {
  readonly adapter?: unknown;
  readonly roots?: unknown;
  readonly files?: unknown;
  readonly events?: unknown;
  readonly skipped?: unknown;
  readonly last_event_at?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface ConversationSourceAdapterStatus {
  readonly adapter: string;
  readonly roots: readonly string[];
  readonly files: number;
  readonly events: number;
  readonly skipped: number;
  readonly last_seen: string | null;
  readonly last_event_at: string | null;
}

export interface ConversationSourceRuntimeStatus {
  readonly ok: boolean;
  readonly heartbeat_path: string;
  readonly heartbeat_updated_at: string | null;
  readonly source_cursor_path: string | null;
  readonly source_file_count: number;
  readonly source_events_posted: number;
  readonly source_skipped: number;
  readonly source_skipped_existing_files: number;
  readonly adapters: readonly ConversationSourceAdapterStatus[];
  readonly error?: string;
}

export async function readConversationSourceRuntimeStatus(runtimeDir: string): Promise<ConversationSourceRuntimeStatus> {
  const heartbeatPath = path.join(runtimeDir, "conversation-monitor-heartbeat.json");
  try {
    const heartbeat = objectValue(JSON.parse(await readFile(heartbeatPath, "utf8")));
    const updatedAt = stringValue(heartbeat.updated_at);
    const adapters = Array.isArray(heartbeat.source_adapters)
      ? (heartbeat.source_adapters as HeartbeatAdapter[]).map((adapter) => ({
        adapter: stringValue(adapter.adapter) ?? "unknown",
        roots: stringArrayValue(adapter.roots),
        files: numberValue(adapter.files),
        events: numberValue(adapter.events),
        skipped: numberValue(adapter.skipped),
        last_seen: updatedAt,
        last_event_at: stringValue(adapter.last_event_at),
      }))
      : [];
    return {
      ok: Boolean(heartbeat.ok ?? true),
      heartbeat_path: heartbeatPath,
      heartbeat_updated_at: updatedAt,
      source_cursor_path: stringValue(heartbeat.source_cursor_path),
      source_file_count: stringArrayValue(heartbeat.source_files).length,
      source_events_posted: numberValue(heartbeat.source_events_posted),
      source_skipped: numberValue(heartbeat.source_skipped),
      source_skipped_existing_files: numberValue(heartbeat.source_skipped_existing_files),
      adapters,
    };
  } catch (error) {
    return {
      ok: false,
      heartbeat_path: heartbeatPath,
      heartbeat_updated_at: null,
      source_cursor_path: null,
      source_file_count: 0,
      source_events_posted: 0,
      source_skipped: 0,
      source_skipped_existing_files: 0,
      adapters: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
