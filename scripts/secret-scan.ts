import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

const ROOT = process.cwd();
const EXCLUDED_PREFIXES = [
  ".git/",
  "node_modules/",
  "dist/",
  "artifacts/",
  "migration_artifacts/",
  "reports/",
  "logs/",
  ".logs/",
];

const SECRET_RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: "openai-style-api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "bearer-token-literal", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/ },
  { name: "memory-xx-token-env", pattern: /^\s*MEMORY_XX_(?:API|ADMIN|CLI)_TOKEN\s*=\s*(?!$|changeme|example|redacted|<)[^#\s]+/ },
  { name: "external-api-key-env", pattern: /^\s*(?:OPENAI_API_KEY|QDRANT_API_KEY|FEISHU_[A-Z_]*SECRET)\s*=\s*(?!$|changeme|example|redacted|<)[^#\s]+/ },
  { name: "postgres-url-with-password", pattern: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@(?!(?:127\.0\.0\.1|localhost|postgres|memory-xx-postgres)(?::|\/))/ },
];

const TEST_FIXTURE_ALLOW_MARKER = "memory-xx-secret-scan: allow-test-fixture";

function listCandidateFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .filter((file) => {
      try {
        return statSync(join(ROOT, file)).isFile();
      } catch {
        return false;
      }
    });
}

export function scanTextForSecrets(file: string, content: string): Finding[] {
  return content.split(/\r?\n/).flatMap((text, index) => {
    if (text.includes(TEST_FIXTURE_ALLOW_MARKER)) {
      return [];
    }
    return (
    SECRET_RULES
      .filter((rule) => rule.pattern.test(text))
      .map((rule) => ({ file, line: index + 1, rule: rule.name }))
    );
  });
}

function scanFile(file: string): Finding[] {
  const content = readFileSync(join(ROOT, file));
  if (content.includes(0)) return [];
  return scanTextForSecrets(file, content.toString("utf8"));
}

export function main(): void {
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
}

if (require.main === module) {
  main();
}
