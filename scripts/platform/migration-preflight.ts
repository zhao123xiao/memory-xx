import { existsSync } from "node:fs";
import path from "node:path";

import { runSecretAudit } from "../security/secrets-audit.js";
import { collectPlatformDoctor, type PlatformRuntimeProfile } from "./platform-doctor.js";

export interface MigrationPreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly severity: "critical" | "warning" | "info";
  readonly detail: string;
}

export interface MigrationPreflightReport {
  readonly ok: boolean;
  readonly checked_at: string;
  readonly profile: PlatformRuntimeProfile;
  readonly status: "ready" | "blocked" | "manual_steps_required";
  readonly checks: readonly MigrationPreflightCheck[];
  readonly manual_steps: readonly string[];
}

function check(name: string, ok: boolean, severity: MigrationPreflightCheck["severity"], detail: string): MigrationPreflightCheck {
  return { name, ok, severity, detail };
}

export async function buildMigrationPreflight(input: {
  readonly profile: PlatformRuntimeProfile;
  readonly projectRoot?: string;
}): Promise<MigrationPreflightReport> {
  const projectRoot = input.projectRoot ?? process.cwd();
  const platform = await collectPlatformDoctor({ profile: input.profile });
  const secretAudit = runSecretAudit({ roots: [projectRoot, path.resolve(projectRoot, "../mem0")] });
  const checks: MigrationPreflightCheck[] = [
    check("platform-profile", platform.profiles[input.profile].available, "critical", `profile=${input.profile}, os=${platform.current_os}`),
    check("platform-components", platform.components.every((item) => item.ok), "critical", `components=${platform.components.map((item) => `${item.name}:${item.status}`).join(",")}`),
    check("tracked-secrets", secretAudit.blocker_count === 0, "critical", `tracked_secret_blockers=${secretAudit.blocker_count}`),
    check("env-example", existsSync(path.join(projectRoot, ".env.example")), "critical", ".env.example present"),
    check("migrations", existsSync(path.join(projectRoot, "migrations")), "critical", "migrations directory present"),
    check("systemd-templates", existsSync(path.join(projectRoot, "systemd")), "warning", "systemd templates present"),
    check("windows-scripts", existsSync(path.join(projectRoot, "scripts", "windows")), "warning", "Windows scripts directory present"),
    check("docker-compose", existsSync(path.join(projectRoot, "docker-compose.yml")), "warning", "docker-compose.yml present"),
  ];
  const failedCritical = checks.filter((item) => item.severity === "critical" && !item.ok);
  const failedWarnings = checks.filter((item) => item.severity === "warning" && !item.ok);
  return {
    ok: failedCritical.length === 0,
    checked_at: new Date().toISOString(),
    profile: input.profile,
    status: failedCritical.length > 0 ? "blocked" : failedWarnings.length > 0 ? "manual_steps_required" : "ready",
    checks,
    manual_steps: [
      ...platform.next_actions,
      ...secretAudit.rotation_required.map((item) => `轮换或确认未泄露：${item}`),
      ...(failedWarnings.length > 0 ? failedWarnings.map((item) => `补齐可选迁移资产：${item.name}`) : []),
    ],
  };
}
