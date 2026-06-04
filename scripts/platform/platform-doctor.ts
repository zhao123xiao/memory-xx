import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PlatformRuntimeProfile = "linux-systemd" | "wsl-windows-gpu" | "windows-native" | "docker-compose-local";
export type RuntimeOs = "linux" | "wsl" | "windows" | "darwin" | "unknown";

export interface PlatformFacts {
  readonly platform: NodeJS.Platform | string;
  readonly releaseText: string;
  readonly hasSystemctl: boolean;
  readonly hasDocker: boolean;
  readonly hasPowerShell: boolean;
  readonly ovmsDirExists: boolean;
}

export interface ProfileStatus {
  readonly profile: PlatformRuntimeProfile;
  readonly available: boolean;
  readonly missing: readonly string[];
  readonly start_hint: string;
}

export interface PlatformDetection {
  readonly current_os: RuntimeOs;
  readonly is_wsl: boolean;
  readonly recommended_profile: PlatformRuntimeProfile;
  readonly profiles: Record<PlatformRuntimeProfile, ProfileStatus>;
}

export interface NormalizedServiceInput {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly probeOk: boolean;
  readonly probeError?: string;
  readonly fallbackOk?: boolean;
  readonly fallbackDetail?: string;
}

export interface NormalizedServiceStatus {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly ok: boolean;
  readonly status: "ok" | "degraded" | "blocked";
  readonly probe_degraded: boolean;
  readonly detail: string;
  readonly degraded_reason?: string;
}

export interface PlatformDoctorReport extends PlatformDetection {
  readonly ok: boolean;
  readonly checked_at: string;
  readonly requested_profile: PlatformRuntimeProfile;
  readonly service_manager: "systemd-user" | "powershell" | "docker-compose" | "none";
  readonly components: readonly NormalizedServiceStatus[];
  readonly next_actions: readonly string[];
}

export function detectRuntimeOs(facts: Pick<PlatformFacts, "platform" | "releaseText">): RuntimeOs {
  if (facts.platform === "win32") return "windows";
  if (facts.platform === "darwin") return "darwin";
  if (facts.platform === "linux") {
    return /microsoft|wsl/iu.test(facts.releaseText) ? "wsl" : "linux";
  }
  return "unknown";
}

function profileStatus(profile: PlatformRuntimeProfile, missing: readonly string[], startHint: string): ProfileStatus {
  return {
    profile,
    available: missing.length === 0,
    missing,
    start_hint: startHint,
  };
}

export function detectPlatformProfile(facts: PlatformFacts): PlatformDetection {
  const currentOs = detectRuntimeOs(facts);
  const profiles: Record<PlatformRuntimeProfile, ProfileStatus> = {
    "linux-systemd": profileStatus(
      "linux-systemd",
      [
        ...(facts.platform === "linux" ? [] : ["linux"]),
        ...(facts.hasSystemctl ? [] : ["systemctl"]),
      ],
      "systemctl --user start memory-xx.target",
    ),
    "wsl-windows-gpu": profileStatus(
      "wsl-windows-gpu",
      [
        ...(currentOs === "wsl" ? [] : ["wsl"]),
        ...(facts.hasPowerShell ? [] : ["windows_powershell"]),
        ...(facts.ovmsDirExists ? [] : ["MEMORY_XX_OVMS_DIR 指向的本地 OVMS 目录"]),
      ],
      "systemctl --user start memory-xx.target；if needed, start the optional local upstream manager configured by MEMORY_XX_OVMS_DIR",
    ),
    "windows-native": profileStatus(
      "windows-native",
      [
        ...(facts.platform === "win32" ? [] : ["windows"]),
        ...(facts.hasPowerShell ? [] : ["powershell"]),
        ...(facts.ovmsDirExists ? [] : ["MEMORY_XX_OVMS_DIR 指向的本地 upstream 目录"]),
      ],
      "powershell -ExecutionPolicy Bypass -File scripts/windows/start-memory-xx.ps1",
    ),
    "docker-compose-local": profileStatus(
      "docker-compose-local",
      facts.hasDocker ? [] : ["docker"],
      "docker compose up -d",
    ),
  };
  const recommended: PlatformRuntimeProfile = currentOs === "windows"
    ? "windows-native"
    : currentOs === "wsl" && profiles["wsl-windows-gpu"].available
      ? "wsl-windows-gpu"
      : profiles["linux-systemd"].available
        ? "linux-systemd"
        : "docker-compose-local";
  return {
    current_os: currentOs,
    is_wsl: currentOs === "wsl",
    recommended_profile: recommended,
    profiles,
  };
}

export function normalizeServiceStatus(input: NormalizedServiceInput): NormalizedServiceStatus {
  if (input.probeOk) {
    return {
      name: input.name,
      label: input.label,
      required: input.required,
      ok: true,
      status: "ok",
      probe_degraded: false,
      detail: "primary probe ok",
    };
  }
  if (input.fallbackOk) {
    return {
      name: input.name,
      label: input.label,
      required: input.required,
      ok: true,
      status: "degraded",
      probe_degraded: true,
      detail: input.fallbackDetail ?? "fallback probe ok",
      degraded_reason: input.probeError,
    };
  }
  return {
    name: input.name,
    label: input.label,
    required: input.required,
    ok: !input.required,
    status: input.required ? "blocked" : "degraded",
    probe_degraded: Boolean(input.probeError),
    detail: input.probeError ?? "probe failed",
    degraded_reason: input.probeError,
  };
}

function commandExists(command: string): boolean {
  try {
    execFileSyncCompat(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function execFileSyncCompat(command: string, args: readonly string[]): string {
  return execFileSync(command, args as string[], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
}

function releaseText(): string {
  try {
    return `${os.release()}\n${readFileSync("/proc/version", "utf8")}`;
  } catch {
    return os.release();
  }
}

export function collectPlatformFacts(env: NodeJS.ProcessEnv = process.env): PlatformFacts {
  const powerShell = env.MEMORY_XX_WINDOWS_POWERSHELL_EXE?.trim() || "";
  const ovmsDir = env.MEMORY_XX_OVMS_DIR?.trim() || "<memory-xx-ovms-dir>";
  return {
    platform: process.platform,
    releaseText: releaseText(),
    hasSystemctl: commandExists("systemctl"),
    hasDocker: commandExists("docker"),
    hasPowerShell: (powerShell ? existsSync(powerShell) : false) || commandExists("powershell") || commandExists("pwsh"),
    ovmsDirExists: existsSync(ovmsDir),
  };
}

async function httpOk(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function systemdProbe(): Promise<{ ok: boolean; error?: string }> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR?.trim() || (uid === null ? "" : `/run/user/${uid}`);
  const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS?.trim() || (xdgRuntimeDir ? `unix:path=${xdgRuntimeDir}/bus` : "");
  try {
    await execFileAsync("systemctl", ["--user", "show", "memory-xx-wrapper.service", "--property=ActiveState", "--no-pager"], {
      env: {
        ...process.env,
        ...(xdgRuntimeDir ? { XDG_RUNTIME_DIR: xdgRuntimeDir } : {}),
        ...(busAddress ? { DBUS_SESSION_BUS_ADDRESS: busAddress } : {}),
      },
      timeout: 5000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function serviceManagerForProfile(profile: PlatformRuntimeProfile): PlatformDoctorReport["service_manager"] {
  if (profile === "windows-native") return "powershell";
  if (profile === "docker-compose-local") return "docker-compose";
  if (profile === "linux-systemd" || profile === "wsl-windows-gpu") return "systemd-user";
  return "none";
}

export async function collectPlatformDoctor(input: {
  readonly profile?: PlatformRuntimeProfile;
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<PlatformDoctorReport> {
  const detection = detectPlatformProfile(collectPlatformFacts(input.env ?? process.env));
  const requested = input.profile ?? detection.recommended_profile;
  const systemd = await systemdProbe();
  const wrapperOk = await httpOk((input.env ?? process.env).MEMORY_XX_WRAPPER_URL ?? "http://127.0.0.1:5100/health");
  const embeddingOk = await httpOk("http://127.0.0.1:8082/v3/models") || await httpOk("http://127.0.0.1:5221/health");
  const rerankerOk = await httpOk("http://127.0.0.1:8084/v3/models") || await httpOk("http://127.0.0.1:8085/health");
  const components = [
    normalizeServiceStatus({
      name: "wrapper",
      label: "记忆主服务",
      required: true,
      probeOk: systemd.ok,
      probeError: systemd.error,
      fallbackOk: wrapperOk,
      fallbackDetail: "HTTP health ok",
    }),
    normalizeServiceStatus({
      name: "embedding_upstream",
      label: "Windows/Linux embedding 上游",
      required: requested === "wsl-windows-gpu" || requested === "windows-native",
      probeOk: embeddingOk,
      probeError: embeddingOk ? undefined : "embedding upstream health failed",
    }),
    normalizeServiceStatus({
      name: "reranker_upstream",
      label: "Windows/Linux reranker 上游",
      required: requested === "wsl-windows-gpu" || requested === "windows-native",
      probeOk: rerankerOk,
      probeError: rerankerOk ? undefined : "reranker upstream health failed",
    }),
  ];
  const profile = detection.profiles[requested];
  const nextActions = [
    ...profile.missing.map((item) => `补齐 ${item} 后再运行 profile=${requested} 预检。`),
    ...components.filter((item) => !item.ok).map((item) => `${item.label} 不可用：${item.detail}`),
  ];
  return {
    ...detection,
    ok: profile.available && components.every((item) => item.ok),
    checked_at: new Date().toISOString(),
    requested_profile: requested,
    service_manager: serviceManagerForProfile(requested),
    components,
    next_actions: nextActions,
  };
}
