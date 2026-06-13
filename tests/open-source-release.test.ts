import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildOpenSourcePreauditReport,
  exportOpenSourceProject,
} from "../app/ops/open-source-release";

const LEGACY_PROJECT_NAME = ["memory", "v2"].join("-");
const LEGACY_PROJECT_SNAKE = ["memory", "v2"].join("_");
const LEGACY_PROJECT_TITLE = ["Memory", "V2"].join(" ");
const PRIVATE_TEST_USER = ["xiao", "xiao"].join("");
const PRIVATE_WINDOWS_TEST_USER = String.fromCharCode(0x8d75, 0x6653, 0x6653);

async function withTempDir<T>(callback: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-xx-export-"));
  try {
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, fullPath).replace(/\\/gu, "/"));
      }
    }
  }
  visit(root);
  return files.sort();
}

function readTextFiles(root: string): string {
  return listFiles(root).flatMap((relative) => {
    const fullPath = path.join(root, relative);
    const info = statSync(fullPath);
    if (info.size > 1024 * 1024) return [];
    const content = readFileSync(fullPath);
    if (content.includes(0)) return [];
    return [`--- ${relative} ---\n${content.toString("utf8")}`];
  }).join("\n");
}

test("open source preaudit blocks private paths, runtime data, raw corpora, and manual dumps", async () => {
  await withTempDir(async (root) => {
    const privateProjectRoot = ["/home", PRIVATE_TEST_USER, "services", LEGACY_PROJECT_NAME].join("/");
    const privateWindowsRoot = ["/mnt/c", "Users", PRIVATE_WINDOWS_TEST_USER].join("/");
    write(root, "package.json", JSON.stringify({ name: LEGACY_PROJECT_NAME }));
    write(root, "app/index.ts", `export const root = '${privateProjectRoot}';\n`);
    write(root, "README.md", `Codex sessions live under ${privateWindowsRoot}/.codex/sessions.\n`);
    write(root, ".env", "MEMORY_XX_API_TOKEN=real-token-value\n");
    write(root, "reports/private.json", "{\"memory\":\"private\"}\n");
    write(root, "data/policy-corpus/sources/memory-benchmarks/raw.json", "{\"row\":1}\n");
    const fakeBearer = `Bearer ${"abcdefghijklmnopqrstuvwxyz"}123456`;
    write(root, "test_write_full.sh", `curl -H 'Authorization: ${fakeBearer}'\n`);

    const report = await buildOpenSourcePreauditReport({ root });

    assert.equal(report.ok, false);
    assert.ok(report.blockers.some((item) => item.kind === "private_path_literal"));
    assert.ok(report.blockers.some((item) => item.kind === "private_env_file"));
    assert.ok(report.blockers.some((item) => item.kind === "runtime_or_report_data"));
    assert.ok(report.blockers.some((item) => item.kind === "raw_benchmark_source"));
    assert.ok(report.blockers.some((item) => item.kind === "manual_dump_or_debug_artifact"));
  });
});

test("open source export creates a sanitized memory-xx tree from allowlisted files", async () => {
  await withTempDir(async (parent) => {
    const root = path.join(parent, "private-source");
    const targetDir = path.join(parent, "memory-xx");
    const privateProjectRoot = ["/home", PRIVATE_TEST_USER, "services", LEGACY_PROJECT_NAME].join("/");
    const privateWindowsDesktop = ["/mnt/c", "Users", PRIVATE_WINDOWS_TEST_USER, "Desktop"].join("/");
    write(root, "package.json", JSON.stringify({
      name: LEGACY_PROJECT_NAME,
      version: "0.1.0",
      scripts: {
        test: "node --import tsx --test tests/*.test.ts",
        "check:secrets": "tsx scripts/secret-scan.ts",
      },
    }, null, 2));
    write(root, "README.md", `# memory-xx\n\nPrivate path: ${privateProjectRoot}\nWindows: ${privateWindowsDesktop}\n`);
    write(root, ".env.example", "MEMORY_XX_API_TOKEN=<set-in-env>\nOPENAI_API_KEY=<set-in-env>\n");
    write(root, "app/index.ts", `export const defaultRoot = '${privateProjectRoot}';\n`);
    write(root, "scripts/tool.ts", "console.log('memory-xx');\n");
    write(root, "tests/sample.test.ts", "import test from 'node:test';\ntest('sample', () => {});\n");
    write(root, ".github/workflows/ci.yml", "name: ci\n");
    write(root, ".env", "MEMORY_XX_API_TOKEN=real-token-value\n");
    write(root, "reports/private.json", "{\"memory\":\"private\"}\n");
    write(root, "data/policy-corpus/sources/memory-benchmarks/raw.json", "{\"row\":1}\n");
    write(root, "test_write_full.sh", "private dump\n");

    const result = await exportOpenSourceProject({ root, targetDir, apply: true });

    assert.equal(result.ok, true);
    assert.equal(result.package_name, "memory-xx");
    assert.equal(JSON.parse(readFileSync(path.join(targetDir, "package.json"), "utf8")).name, "memory-xx");
    assert.equal(existsSync(path.join(targetDir, ".env")), false);
    assert.equal(existsSync(path.join(targetDir, "reports", "private.json")), false);
    assert.equal(existsSync(path.join(targetDir, "data", "policy-corpus", "sources", "memory-benchmarks", "raw.json")), false);
    assert.equal(existsSync(path.join(targetDir, "test_write_full.sh")), false);
    assert.equal(existsSync(path.join(targetDir, "tests", "open-source-release.test.ts")), false);
    assert.ok(readFileSync(path.join(targetDir, "LICENSE"), "utf8").includes("MIT License"));
    assert.ok(readFileSync(path.join(targetDir, "SECURITY.md"), "utf8").includes("Do not commit"));
    assert.ok(readFileSync(path.join(targetDir, "CONTRIBUTING.md"), "utf8").includes("synthetic"));
    assert.ok(readFileSync(path.join(targetDir, "OPEN_SOURCE_AUDIT.md"), "utf8").includes("memory-xx"));

    const exportedReadme = readFileSync(path.join(targetDir, "README.md"), "utf8");
    const exportedSource = readFileSync(path.join(targetDir, "app", "index.ts"), "utf8");
    assert.match(exportedReadme, /memory-xx/u);
    const blockedLiteralPattern = new RegExp([
      `\\/home\\/${PRIVATE_TEST_USER}`,
      "\\/mnt\\/c\\/Users",
      PRIVATE_WINDOWS_TEST_USER,
      LEGACY_PROJECT_NAME,
    ].join("|"), "u");
    assert.doesNotMatch(`${exportedReadme}\n${exportedSource}`, blockedLiteralPattern);
  });
});

test("open source export publishes env examples, public docs, and memory-xx deployment names", async () => {
  await withTempDir(async (parent) => {
    const root = path.join(parent, "private-source");
    const targetDir = path.join(parent, "memory-xx");
    const privateProjectRoot = ["/home", PRIVATE_TEST_USER, "services", LEGACY_PROJECT_NAME].join("/");
    const fakeOpenAiKey = `${"sk-"}live-secret-value-1234567890`;
    write(root, "package.json", JSON.stringify({ name: LEGACY_PROJECT_NAME }));
    write(root, ".env.example", `MEMORY_XX_API_TOKEN=real-looking-token\nOPENAI_API_KEY=${fakeOpenAiKey}\n`);
    write(root, `configs/${LEGACY_PROJECT_NAME}.env.example`, `MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/${LEGACY_PROJECT_SNAKE}\n`);
    write(root, `configs/${LEGACY_PROJECT_NAME}-wrapper.env.example`, "MEMORY_XX_API_TOKEN=wrapper-token\n");
    write(root, `configs/${LEGACY_PROJECT_NAME}-qdrant-projector-worker.env.example`, "QDRANT_API_KEY=qdrant-token\n");
    write(root, "docs/api.md", `# ${LEGACY_PROJECT_NAME} API\n\nRoot ${privateProjectRoot}\n`);
    write(root, "docs/architecture.md", `# ${LEGACY_PROJECT_NAME} Architecture\n`);
    write(root, "docs/operations.md", `# ${LEGACY_PROJECT_NAME} Operations\n`);
    write(root, "docs/runtime-profiles.md", `# ${LEGACY_PROJECT_NAME} Runtime Profiles\n`);
    write(root, "docs/migration-rollback-playbook.md", `# ${LEGACY_PROJECT_NAME} Rollback\n`);
    write(root, "docs/runbooks/backup-restore.md", `# ${LEGACY_PROJECT_NAME} Backup\n`);
    write(root, "docs/runbooks/migration-rollback.md", `# ${LEGACY_PROJECT_NAME} Migration Rollback\n`);
    write(root, "docs/runbooks/recall-quality.md", `# ${LEGACY_PROJECT_NAME} Recall Quality\n`);
    write(root, "docs/完整测试方案.md", "# internal private plan\n");
    write(root, "docs/_ws1-p0-systemd-lease-audit-metrics.md", "# internal workspace plan\n");
    write(root, `systemd/${LEGACY_PROJECT_NAME}-maintenance.service`, [
      "[Service]",
      `Description=Run ${LEGACY_PROJECT_NAME} maintenance`,
      `WorkingDirectory=%h/services/${LEGACY_PROJECT_NAME}`,
      `EnvironmentFile=%h/services/${LEGACY_PROJECT_NAME}/.env`,
      `StandardOutput=append:%h/services/${LEGACY_PROJECT_NAME}/maintenance.log`,
      "",
    ].join("\n"));
    write(root, "deploy/prometheus/prometheus.yml", `scrape_configs:\n  - job_name: ${LEGACY_PROJECT_NAME}\n`);
    write(root, `deploy/grafana/${LEGACY_PROJECT_NAME}-dashboard.json`, `{"title":"${LEGACY_PROJECT_NAME} operations"}\n`);
    write(root, "docker-compose.yml", `services:\n  ${LEGACY_PROJECT_NAME}:\n    image: ${LEGACY_PROJECT_NAME}\n`);

    const result = await exportOpenSourceProject({ root, targetDir, apply: true });

    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(targetDir, ".env.example")), true);
    assert.equal(existsSync(path.join(targetDir, "configs", "memory-xx.env.example")), true);
    assert.equal(existsSync(path.join(targetDir, "configs", "memory-xx-wrapper.env.example")), true);
    assert.equal(existsSync(path.join(targetDir, "configs", "memory-xx-qdrant-projector-worker.env.example")), true);
    assert.equal(existsSync(path.join(targetDir, "configs", `${LEGACY_PROJECT_NAME}.env.example`)), false);
    assert.equal(existsSync(path.join(targetDir, "docs", "api.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "architecture.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "operations.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "runtime-profiles.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "migration-rollback-playbook.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "runbooks", "backup-restore.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "runbooks", "migration-rollback.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "runbooks", "recall-quality.md")), true);
    assert.equal(existsSync(path.join(targetDir, "docs", "完整测试方案.md")), false);
    assert.equal(existsSync(path.join(targetDir, "docs", "_ws1-p0-systemd-lease-audit-metrics.md")), false);
    assert.equal(existsSync(path.join(targetDir, "systemd", "memory-xx-maintenance.service")), true);
    assert.equal(existsSync(path.join(targetDir, "systemd", `${LEGACY_PROJECT_NAME}-maintenance.service`)), false);
    assert.equal(existsSync(path.join(targetDir, "deploy", "grafana", "memory-xx-dashboard.json")), true);
    assert.equal(existsSync(path.join(targetDir, "deploy", "grafana", `${LEGACY_PROJECT_NAME}-dashboard.json`)), false);

    const exported = [
      readFileSync(path.join(targetDir, ".env.example"), "utf8"),
      readFileSync(path.join(targetDir, "configs", "memory-xx.env.example"), "utf8"),
      readFileSync(path.join(targetDir, "docs", "api.md"), "utf8"),
      readFileSync(path.join(targetDir, "systemd", "memory-xx-maintenance.service"), "utf8"),
      readFileSync(path.join(targetDir, "deploy", "prometheus", "prometheus.yml"), "utf8"),
      readFileSync(path.join(targetDir, "deploy", "grafana", "memory-xx-dashboard.json"), "utf8"),
      readFileSync(path.join(targetDir, "docker-compose.yml"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(exported, new RegExp(`\\/home\\/${PRIVATE_TEST_USER}|\\/mnt\\/c\\/Users|${PRIVATE_WINDOWS_TEST_USER}|%h\\/services\\/${LEGACY_PROJECT_NAME}|sk-live-secret|real-looking-token|wrapper-token|qdrant-token`, "u"));
    assert.match(exported, /memory-xx/u);
  });
});

test("open source export rewrites public memory-xx branding, defaults, and file names to memory-xx", async () => {
  await withTempDir(async (parent) => {
    const root = path.join(parent, "private-source");
    const targetDir = path.join(parent, "memory-xx");
    write(root, "package.json", JSON.stringify({
      name: LEGACY_PROJECT_NAME,
      scripts: {
        start: `tsx scripts/klee-${LEGACY_PROJECT_NAME}-wrapper.ts`,
        functional: `bash scripts/functional-test-${LEGACY_PROJECT_NAME}.sh`,
      },
    }, null, 2));
    write(root, ".env.example", [
      `# ${LEGACY_PROJECT_TITLE} Wrapper Configuration`,
      `MEMORY_XX_QDRANT_COLLECTION=${LEGACY_PROJECT_NAME}`,
      `MEMORY_XX_CACHE_KEY_PREFIX=${LEGACY_PROJECT_SNAKE}`,
      "",
    ].join("\n"));
    write(root, "Dockerfile", `CMD ["tsx", "scripts/klee-${LEGACY_PROJECT_NAME}-wrapper.ts"]\n`);
    write(root, `scripts/klee-${LEGACY_PROJECT_NAME}-wrapper.ts`, `export const service = '${LEGACY_PROJECT_NAME}';\n`);
    write(root, `scripts/functional-test-${LEGACY_PROJECT_NAME}.sh`, `echo ${LEGACY_PROJECT_NAME}\n`);
    write(root, `scripts/windows/start-${LEGACY_PROJECT_NAME}.ps1`, `Write-Host "${LEGACY_PROJECT_NAME}"\n`);
    write(root, `scripts/windows/status-${LEGACY_PROJECT_NAME}.ps1`, `[string]$ProjectRoot = '<windows-drive>\\${LEGACY_PROJECT_NAME}'\n`);
    write(root, `scripts/windows/stop-${LEGACY_PROJECT_NAME}.ps1`, `Write-Host "stop ${LEGACY_PROJECT_NAME}"\n`);
    write(root, "app/governance/defaults.ts", [
      `export const DEFAULT_PROJECT_IDS = ['${LEGACY_PROJECT_NAME}'];`,
      `export const DEFAULT_SELF_IMPROVEMENT_PROJECT_IDS = ['${LEGACY_PROJECT_NAME}-self-improvement'];`,
      `export const source = '${LEGACY_PROJECT_NAME}-intelligence-smart-write';`,
      "export const route = '/api/memory/xx/recall';",
      "",
    ].join("\n"));
    write(root, "tests/sample.test.ts", [
      "import assert from 'node:assert/strict';",
      `assert.equal('${LEGACY_PROJECT_NAME}', '${LEGACY_PROJECT_NAME}');`,
      "",
    ].join("\n"));

    const result = await exportOpenSourceProject({ root, targetDir, apply: true });

    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(targetDir, "scripts", `klee-${LEGACY_PROJECT_NAME}-wrapper.ts`)), false);
    assert.equal(existsSync(path.join(targetDir, "scripts", "memory-xx-wrapper.ts")), true);
    assert.equal(existsSync(path.join(targetDir, "scripts", `functional-test-${LEGACY_PROJECT_NAME}.sh`)), false);
    assert.equal(existsSync(path.join(targetDir, "scripts", "functional-test-memory-xx.sh")), true);
    assert.equal(existsSync(path.join(targetDir, "scripts", "windows", `start-${LEGACY_PROJECT_NAME}.ps1`)), false);
    assert.equal(existsSync(path.join(targetDir, "scripts", "windows", "start-memory-xx.ps1")), true);

    const exportedFiles = listFiles(targetDir);
    assert.deepEqual(exportedFiles.filter((file) => new RegExp(`${LEGACY_PROJECT_NAME}|${LEGACY_PROJECT_TITLE}`, "u").test(file)), []);

    const exportedText = readTextFiles(targetDir);
    assert.doesNotMatch(exportedText, new RegExp(`${LEGACY_PROJECT_NAME}|${LEGACY_PROJECT_TITLE}|${LEGACY_PROJECT_SNAKE}|klee-memory-xx-wrapper`, "u"));
    assert.match(readFileSync(path.join(targetDir, "package.json"), "utf8"), /"start": "tsx scripts\/memory-xx-wrapper\.ts"/u);
    assert.match(readFileSync(path.join(targetDir, "Dockerfile"), "utf8"), /scripts\/memory-xx-wrapper\.ts/u);
    assert.match(exportedText, /MEMORY_XX_QDRANT_COLLECTION=memory-xx/u);
    assert.match(exportedText, /MEMORY_XX_CACHE_KEY_PREFIX=memory_xx/u);
    assert.match(exportedText, /\/api\/memory\/xx\/recall/u);
  });
});

test("open source export refuses to apply when target is the source root", async () => {
  await withTempDir(async (root) => {
    write(root, "package.json", JSON.stringify({ name: "memory-xx" }));

    await assert.rejects(
      () => exportOpenSourceProject({ root, targetDir: root, apply: true, targetExplicit: true }),
      /refusing_open_source_export_target_inside_source_root/u,
    );
  });
});

test("open source export backs up conversation cursors before apply cleanup", async () => {
  await withTempDir(async (parent) => {
    const root = path.join(parent, "private-source");
    const targetDir = path.join(parent, "memory-xx");
    write(root, "package.json", JSON.stringify({ name: "memory-xx" }));
    write(root, ".runtime/conversation-sources.cursor.json", "{\"files\":{\"source.jsonl\":123}}\n");
    write(root, ".runtime/conversation-events/.cursor.json", "{\"files\":{\"spool.jsonl\":456}}\n");

    const result = await exportOpenSourceProject({
      root,
      targetDir,
      apply: true,
      targetExplicit: true,
      backupId: "test-backup",
    });

    assert.deepEqual(result.runtime_cursor_backups, [
      ".runtime/open-source-export-cursor-backups/test-backup/conversation-events/.cursor.json",
      ".runtime/open-source-export-cursor-backups/test-backup/conversation-sources.cursor.json",
    ]);
    assert.equal(readFileSync(path.join(root, result.runtime_cursor_backups[0]), "utf8"), "{\"files\":{\"spool.jsonl\":456}}\n");
    assert.equal(readFileSync(path.join(root, result.runtime_cursor_backups[1]), "utf8"), "{\"files\":{\"source.jsonl\":123}}\n");
    assert.equal(existsSync(path.join(targetDir, ".runtime")), false);
  });
});
