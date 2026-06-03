import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

export interface UserSystemdState {
  readonly raw: Record<string, string>;
  readonly available: boolean;
  readonly probe_degraded: boolean;
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly unitFileState: string;
  readonly execMainStatus: string;
  readonly mainPid: string;
  readonly error?: string;
}

export interface StatusFileFallback {
  readonly ok: boolean;
  readonly probe_degraded: true;
  readonly reason: string;
  readonly diagnostics: readonly string[];
  readonly status?: Record<string, unknown>;
}

export function buildSystemdUserEnv(
  env: NodeJS.ProcessEnv = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : null
): NodeJS.ProcessEnv {
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR?.trim() || (uid === null ? "" : `/run/user/${uid}`);
  const busAddress = env.DBUS_SESSION_BUS_ADDRESS?.trim() || (xdgRuntimeDir ? `unix:path=${xdgRuntimeDir}/bus` : "");
  return {
    ...env,
    ...(xdgRuntimeDir ? { XDG_RUNTIME_DIR: xdgRuntimeDir } : {}),
    ...(busAddress ? { DBUS_SESSION_BUS_ADDRESS: busAddress } : {})
  };
}

export function parseSystemdShowOutput(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

export function readUserSystemdState(service: string): UserSystemdState {
  const result = spawnSync(
    "systemctl",
    [
      "--user",
      "show",
      service,
      "--property=LoadState,ActiveState,SubState,UnitFileState,ExecMainStatus,MainPID",
      "--no-pager"
    ],
    {
      encoding: "utf8",
      env: buildSystemdUserEnv()
    }
  );

  if (result.error) {
    return unavailableSystemdState(result.error.message);
  }

  if (result.status !== 0) {
    return unavailableSystemdState((result.stderr || result.stdout || "systemctl failed").trim());
  }

  const raw = parseSystemdShowOutput(result.stdout);
  return {
    raw,
    available: true,
    probe_degraded: false,
    loadState: raw.LoadState ?? "unknown",
    activeState: raw.ActiveState ?? "unknown",
    subState: raw.SubState ?? "unknown",
    unitFileState: raw.UnitFileState ?? "unknown",
    execMainStatus: raw.ExecMainStatus ?? "unknown",
    mainPid: raw.MainPID ?? "unknown"
  };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function evaluateStatusFileFallback(
  statusFile: string,
  options: {
    readonly staleAfterMs: number;
    readonly now?: () => number;
    readonly isProcessAlive?: (pid: number) => boolean;
  }
): Promise<StatusFileFallback> {
  const diagnostics: string[] = [];
  const now = options.now ?? Date.now;
  const processAlive = options.isProcessAlive ?? isPidAlive;

  let status: Record<string, unknown>;
  try {
    status = JSON.parse(await readFile(statusFile, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      probe_degraded: true,
      reason: "status_file_unreadable",
      diagnostics: [`status file unreadable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  const ts = typeof status.ts === "string" ? Date.parse(status.ts) : NaN;
  if (!Number.isFinite(ts)) diagnostics.push(`status ts missing or invalid: ${String(status.ts)}`);
  else if (now() - ts > options.staleAfterMs) diagnostics.push("status file stale");

  const snapshot = isRecord(status.snapshot) ? status.snapshot : {};
  const running = status.phase === "running" && snapshot.running === true;
  if (!running) diagnostics.push("status file does not describe a running worker");
  if (typeof snapshot.lastError === "string" && snapshot.lastError.trim()) diagnostics.push(`snapshot lastError=${snapshot.lastError}`);
  if (snapshot.lastResultStatus === "dead-lettered") diagnostics.push("lastResultStatus=dead-lettered");

  const pid = typeof status.pid === "number" ? status.pid : null;
  if (pid === null || !processAlive(pid)) diagnostics.push(`status pid not alive: ${String(status.pid)}`);

  return {
    ok: diagnostics.length === 0,
    probe_degraded: true,
    reason: "status_file_pid_fallback",
    diagnostics,
    status
  };
}

function unavailableSystemdState(error: string): UserSystemdState {
  return {
    raw: {},
    available: false,
    probe_degraded: true,
    loadState: "unknown",
    activeState: "unknown",
    subState: "unknown",
    unitFileState: "unknown",
    execMainStatus: "unknown",
    mainPid: "unknown",
    error
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
