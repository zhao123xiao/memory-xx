#!/usr/bin/env tsx
import "./test-harness/config.js";
import path from "node:path";

import {
  defaultConversationSourceConfigs,
  scanConversationSources,
} from "../app/conversation/session-source-adapters";

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const command = process.argv.slice(2).find((item) => !item.startsWith("--")) ?? "scan";
  if (command !== "scan") {
    throw new Error(`unsupported_command:${command}`);
  }

  const runtimeDir = process.env.MEMORY_V2_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
  const cursorPath = argValue("--cursor") || path.join(runtimeDir, "conversation-sources.cursor.json");
  const dryRun = hasArg("--dry-run") || !hasArg("--apply");
  const json = hasArg("--json");
  const backfill = hasArg("--backfill");
  const maxFiles = Number.parseInt(argValue("--max-files") ?? "", 10);

  const result = await scanConversationSources({
    adapters: defaultConversationSourceConfigs(process.env),
    cursorPath,
    readExisting: backfill,
    dryRun,
    ...(Number.isFinite(maxFiles) && maxFiles > 0 ? { maxFilesPerAdapter: maxFiles } : {}),
  });

  const body = {
    ok: true,
    command,
    dry_run: dryRun,
    read_existing: backfill,
    cursor_path: cursorPath,
    source_adapters: result.source_adapters,
    source_file_count: result.source_files.length,
    source_events: result.events.length,
    source_skipped: result.source_skipped,
    skipped_existing_files: result.skipped_existing_files,
    sample_events: result.events.slice(0, 10).map((event) => ({
      id: event.id,
      source: event.source,
      agent_id: event.agent_id,
      conversation_id: event.conversation_id,
      session_id: event.session_id,
      role: event.role,
      observed_at: event.observed_at,
      content_preview: event.content.slice(0, 160),
      metadata: {
        source_adapter: event.metadata.source_adapter,
        source_file: event.metadata.source_file,
        source_offset: event.metadata.source_offset,
        source_line_hash: event.metadata.source_line_hash,
        source_message_id: event.metadata.source_message_id,
      },
    })),
  };

  if (json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(`conversation source scan: events=${body.source_events} files=${body.source_file_count} skipped=${body.source_skipped} dry_run=${body.dry_run}`);
    for (const adapter of body.source_adapters) {
      console.log(`- ${adapter.adapter}: files=${adapter.files} events=${adapter.events} skipped=${adapter.skipped}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
