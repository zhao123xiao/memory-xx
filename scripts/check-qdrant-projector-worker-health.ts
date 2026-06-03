import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateStatusFileFallback,
  readUserSystemdState
} from "../app/ops/systemd-user";

const DEFAULT_STATUS_FILE = "<project-root>/qdrant-projector-worker.status.json";
const DEFAULT_SERVICE = "memory-xx-qdrant-projector-worker.service";
const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000;

interface CliOptions {
  readonly statusFile: string;
  readonly service: string;
  readonly staleAfterMs: number;
  readonly help: boolean;
}

interface StatusSnapshot {
  readonly ts?: string;
  readonly pid?: number;
  readonly phase?: string;
  readonly snapshot?: {
    readonly exporterName?: string;
    readonly running?: boolean;
    readonly stopping?: boolean;
    readonly startedAt?: string | null;
    readonly stoppedAt?: string | null;
    readonly loopCount?: number;
    readonly lastTickAt?: string | null;
    readonly lastResultStatus?: string | null;
    readonly lastError?: string | null;
    readonly lastCursor?: {
      readonly exporterName?: string;
      readonly lastSuccessfulEventId?: string | null;
      readonly cursor?: string | null;
      readonly lastSuccessAt?: string | null;
      readonly failureSummary?: string | null;
      readonly isRebuilding?: boolean;
      readonly updatedAt?: string | null;
    } | null;
  };
  readonly lastLogLevel?: string;
  readonly lastLogMessage?: string;
  readonly lastLogFields?: Record<string, unknown>;
  readonly error?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const staleAfterRaw = get("--stale-after-ms");
  const staleAfterMs = staleAfterRaw ? Number(staleAfterRaw) : DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error("--stale-after-ms must be a positive number.");
  }

  return {
    statusFile: path.resolve(get("--status-file") ?? DEFAULT_STATUS_FILE),
    service: get("--service") ?? DEFAULT_SERVICE,
    staleAfterMs,
    help: has("--help") || has("-h")
  };
}

async function readStatusFile(statusFile: string): Promise<StatusSnapshot> {
  const content = await readFile(statusFile, "utf8");
  return JSON.parse(content) as StatusSnapshot;
}

function formatAge(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m${remainSeconds}s`;
}

function parseTimestamp(raw?: string | null): number | null {
  if (!raw) {
    return null;
  }
  const value = Date.parse(raw);
  return Number.isNaN(value) ? null : value;
}

function printHelp(): void {
  console.log(`Read-only health probe for the qdrant projector worker.

Usage:
  node --import tsx scripts/check-qdrant-projector-worker-health.ts [options]

Options:
  --status-file <path>     Path to qdrant-projector-worker.status.json
  --service <name>         systemd user service name
  --stale-after-ms <ms>    FAIL if status file is older than this threshold
  -h, --help               Show this help
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }

  const diagnostics: string[] = [];
  const systemd = readUserSystemdState(options.service);
  let status: StatusSnapshot | null = null;
  let statusReadError: string | null = null;
  let probeDegraded = systemd.probe_degraded;
  let fallback: Awaited<ReturnType<typeof evaluateStatusFileFallback>> | null = null;

  try {
    status = await readStatusFile(options.statusFile);
  } catch (error) {
    statusReadError = error instanceof Error ? error.message : String(error);
  }

  let ok = true;

  if (!systemd.available) {
    probeDegraded = true;
    diagnostics.push(`systemd user state unavailable: ${systemd.error ?? "unknown error"}`);
    fallback = await evaluateStatusFileFallback(options.statusFile, {
      staleAfterMs: options.staleAfterMs
    });
    ok = fallback.ok;
    diagnostics.push(...fallback.diagnostics);
    if (!status && fallback.status) status = fallback.status as unknown as StatusSnapshot;
  } else {
    if (systemd.loadState !== "loaded") {
      ok = false;
      diagnostics.push(`systemd LoadState=${systemd.loadState}`);
    }
    if (systemd.activeState !== "active") {
      ok = false;
      diagnostics.push(`systemd ActiveState=${systemd.activeState} (SubState=${systemd.subState})`);
    }
    if (systemd.execMainStatus !== "0" && systemd.execMainStatus !== "" && systemd.execMainStatus !== "unknown") {
      ok = false;
      diagnostics.push(`systemd ExecMainStatus=${systemd.execMainStatus}`);
    }
  }

  if (!status) {
    ok = false;
    diagnostics.push(`status file unreadable: ${options.statusFile} (${statusReadError ?? "unknown error"})`);
  } else if (systemd.available) {
    if (status.phase === "failed") {
      ok = false;
      diagnostics.push(`status phase=failed${status.error ? ` error=${status.error}` : ""}`);
    }

    const statusTs = parseTimestamp(status.ts);
    if (statusTs === null) {
      ok = false;
      diagnostics.push(`status ts missing or invalid: ${String(status.ts)}`);
    } else {
      const ageMs = Date.now() - statusTs;
      if (ageMs > options.staleAfterMs) {
        ok = false;
        diagnostics.push(`status file stale: age=${formatAge(ageMs)} threshold=${formatAge(options.staleAfterMs)}`);
      }
    }

    if (status.phase === "running" && status.snapshot?.running !== true) {
      ok = false;
      diagnostics.push("status phase=running but snapshot.running is not true");
    }

    if (status.snapshot?.lastError) {
      ok = false;
      diagnostics.push(`snapshot lastError=${status.snapshot.lastError}`);
    }

    if (status.snapshot?.lastResultStatus === "dead-lettered") {
      ok = false;
      diagnostics.push("lastResultStatus=dead-lettered");
    }

    const filePid = typeof status.pid === "number" ? String(status.pid) : "unknown";
    if (systemd.available && systemd.mainPid !== "0" && filePid !== "unknown" && systemd.mainPid !== filePid) {
      diagnostics.push(`PID mismatch: systemd MainPID=${systemd.mainPid}, status.pid=${filePid}`);
    }
  }

  const summary = ok ? "OK" : "FAIL";
  const output = {
    summary,
    checkedAt: new Date().toISOString(),
    service: options.service,
    statusFile: options.statusFile,
    probe_degraded: probeDegraded,
    fallback: fallback
      ? {
          ok: fallback.ok,
          reason: fallback.reason
        }
      : null,
    systemd: {
      available: systemd.available,
      probe_degraded: systemd.probe_degraded,
      loadState: systemd.loadState,
      activeState: systemd.activeState,
      subState: systemd.subState,
      unitFileState: systemd.unitFileState,
      execMainStatus: systemd.execMainStatus,
      mainPid: systemd.mainPid,
      error: systemd.error
    },
    workerStatus: status
      ? {
          ts: status.ts,
          pid: status.pid,
          phase: status.phase,
          lastLogLevel: status.lastLogLevel,
          lastLogMessage: status.lastLogMessage,
          snapshot: status.snapshot
            ? {
                exporterName: status.snapshot.exporterName,
                running: status.snapshot.running,
                stopping: status.snapshot.stopping,
                startedAt: status.snapshot.startedAt,
                stoppedAt: status.snapshot.stoppedAt,
                loopCount: status.snapshot.loopCount,
                lastTickAt: status.snapshot.lastTickAt,
                lastResultStatus: status.snapshot.lastResultStatus,
                lastError: status.snapshot.lastError,
                lastCursor: status.snapshot.lastCursor
              }
            : null
        }
      : null,
    diagnostics
  };

  console.log(summary);
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = ok ? 0 : 1;
}

void main().catch((error) => {
  console.log("FAIL");
  console.log(
    JSON.stringify(
      {
        summary: "FAIL",
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
