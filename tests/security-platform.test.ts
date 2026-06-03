import assert from "node:assert/strict";
import test from "node:test";

import {
  scanSecretContent,
  summarizeSecretAudit,
} from "../scripts/security/secrets-audit";
import {
  detectPlatformProfile,
  normalizeServiceStatus,
} from "../scripts/platform/platform-doctor";

test("secret scanner blocks tracked literal provider keys and hides raw values", () => {
  const providerKey = `${"s"}k-${"live-secret-value-123456"}`;
  const findings = scanSecretContent({
    file: "/repo/mem0/config.yaml",
    content: `api_key: ${providerKey}\nfallback_api_key: \${MEMORY_INTELLIGENCE_FALLBACK_API_KEY}\n`,
    tracked: true,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "api_key");
  assert.equal(findings[0].severity, "critical");
  assert.equal(findings[0].tracked, true);
  assert.equal(JSON.stringify(findings).includes("sk-live-secret-value"), false);

  const summary = summarizeSecretAudit(findings);
  assert.equal(summary.ok, false);
  assert.equal(summary.blocker_count, 1);
});

test("secret scanner ignores env placeholders and example values", () => {
  const findings = scanSecretContent({
    file: "/repo/mem0/config.example.yaml",
    content: [
      "api_key: ${MEMORY_INTELLIGENCE_API_KEY}",
      "fallback_api_key: <set-in-env>",
      "password: example-password",
      "token: changeme",
    ].join("\n"),
    tracked: true,
  });

  assert.deepEqual(findings, []);
});

test("platform detector classifies linux wsl windows and docker profiles", () => {
  const linux = detectPlatformProfile({
    platform: "linux",
    releaseText: "Linux version 6.6.87.1-microsoft-standard-WSL2",
    hasSystemctl: true,
    hasDocker: true,
    hasPowerShell: true,
    ovmsDirExists: true,
  });

  assert.equal(linux.current_os, "wsl");
  assert.equal(linux.recommended_profile, "wsl-windows-gpu");
  assert.equal(linux.profiles["wsl-windows-gpu"].available, true);
  assert.equal(linux.profiles["linux-systemd"].available, true);
  assert.equal(linux.profiles["docker-compose-local"].available, true);

  const windows = detectPlatformProfile({
    platform: "win32",
    releaseText: "Windows_NT",
    hasSystemctl: false,
    hasDocker: true,
    hasPowerShell: true,
    ovmsDirExists: true,
  });

  assert.equal(windows.current_os, "windows");
  assert.equal(windows.recommended_profile, "windows-native");
  assert.equal(windows.profiles["windows-native"].available, true);
});

test("service status normalization preserves degraded probes without marking required services failed", () => {
  const status = normalizeServiceStatus({
    name: "projector",
    label: "向量投影器",
    required: true,
    probeOk: false,
    probeError: "Failed to connect to bus: No medium found",
    fallbackOk: true,
    fallbackDetail: "status file heartbeat 15s ago",
  });

  assert.equal(status.status, "degraded");
  assert.equal(status.probe_degraded, true);
  assert.equal(status.ok, true);
  assert.match(status.detail, /status file heartbeat/u);
});
