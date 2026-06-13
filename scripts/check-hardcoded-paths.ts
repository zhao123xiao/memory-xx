import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

const ROOT = process.cwd();
const FORBIDDEN_ROOTS = [
  "scripts/",
  "systemd/",
  "deploy/",
  ".github/",
  "configs/",
];
const FORBIDDEN_FILES = new Set(["package.json"]);
const ALLOW_FILES = new Set(["scripts/check-hardcoded-paths.ts"]);
const ALLOW_PREFIXES = [
  "docs/archive/",
  "migration_artifacts/",
  "artifacts/",
];
const RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: "stale-next-project-name", pattern: /memory-xx-next/ },
  { name: "root-services-memory-xx-path", pattern: /\/root\/services\/memory-xx/ },
  { name: "root-local-path", pattern: /\/root\/local/ },
  { name: "private-ovms-wsl-path", pattern: /\/mnt\/d\/ovms/ },
  { name: "private-ovms-api-key-path", pattern: /api_key\.txt/ },
];

function listCandidateFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter(isScannedPath)
    .filter((file) => {
      try {
        return statSync(join(ROOT, file)).isFile();
      } catch {
        return false;
      }
    });
}

function isScannedPath(file: string): boolean {
  if (ALLOW_FILES.has(file)) return false;
  if (ALLOW_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  if (FORBIDDEN_FILES.has(file)) return true;
  return FORBIDDEN_ROOTS.some((prefix) => file.startsWith(prefix));
}

function scanFile(file: string): Finding[] {
  const content = readFileSync(join(ROOT, file));
  if (content.includes(0)) return [];
  return content.toString("utf8").split(/\r?\n/).flatMap((text, index) =>
    RULES
      .filter((rule) => rule.pattern.test(text))
      .map((rule) => ({ file, line: index + 1, rule: rule.name }))
  );
}

const findings = listCandidateFiles().flatMap(scanFile);
if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ ok: findings.length === 0, findings }, null, 2) + "\n");
} else if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line} ${finding.rule}\n`);
  }
}

if (findings.length > 0) {
  process.exitCode = 1;
}
