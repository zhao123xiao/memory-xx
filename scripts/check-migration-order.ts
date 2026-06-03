import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Finding {
  readonly file?: string;
  readonly version?: string;
  readonly rule: string;
  readonly message: string;
}

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const KNOWN_DUPLICATE_EXCEPTIONS = new Map<string, readonly string[]>([
  ["0017", ["0017_governance_run_lease.sql", "0017_scope_generations.sql"]],
]);
const KNOWN_DUPLICATE_REASONS: Record<string, string> = {
  "0017": "Historical split migration already applied in live ledgers; do not rename applied files.",
};
const KNOWN_SCHEMA_HARDCODING_EXCEPTIONS = new Map<string, string>();

const files = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort((left, right) => left.localeCompare(right));

const findings: Finding[] = [];
const byVersion = new Map<string, string[]>();
let previousVersion = -1;

for (const file of files) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
  if (!match) {
    findings.push({
      file,
      rule: "migration-name-format",
      message: "迁移文件名必须使用四位补零格式：NNNN_descriptive_name.sql。",
    });
    continue;
  }

  const version = match[1]!;
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  if (/\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+\S+\s+ON|FROM|JOIN|UPDATE|INTO)\s+memory_xx\./iu.test(sql) && !KNOWN_SCHEMA_HARDCODING_EXCEPTIONS.has(file)) {
    findings.push({
      file,
      version,
      rule: "schema-hardcoding",
      message: "迁移必须依赖已配置的 search_path/schema（搜索路径/数据库命名空间），不要硬编码 memory_xx。",
    });
  }
  const numericVersion = Number(version);
  if (numericVersion < previousVersion) {
    findings.push({
      file,
      version,
      rule: "migration-order",
      message: "迁移文件名必须按版本号非递减排序。",
    });
  }
  previousVersion = numericVersion;

  const group = byVersion.get(version) ?? [];
  group.push(file);
  byVersion.set(version, group);
}

for (const [version, group] of byVersion) {
  if (group.length <= 1) continue;
  const allowed = KNOWN_DUPLICATE_EXCEPTIONS.get(version);
  const sameException =
    allowed &&
    allowed.length === group.length &&
    allowed.every((file) => group.includes(file));
  if (!sameException) {
    findings.push({
      version,
      rule: "duplicate-migration-version",
      message: `Duplicate migration version ${version}: ${group.join(", ")}`,
    });
  }
}

const result = {
  ok: findings.length === 0,
  checked_files: files.length,
  known_duplicate_exceptions: Object.fromEntries(
    [...KNOWN_DUPLICATE_EXCEPTIONS.entries()].map(([version, files]) => [
      version,
      { files, reason: KNOWN_DUPLICATE_REASONS[version] ?? "documented compatibility exception" },
    ])
  ),
  known_schema_hardcoding_exceptions: Object.fromEntries(KNOWN_SCHEMA_HARDCODING_EXCEPTIONS.entries()),
  findings,
};

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(`${finding.file ?? finding.version ?? "migrations"} ${finding.rule}: ${finding.message}\n`);
  }
} else if (KNOWN_DUPLICATE_EXCEPTIONS.size > 0) {
  for (const [version, files] of KNOWN_DUPLICATE_EXCEPTIONS) {
    process.stdout.write(`known duplicate migration ${version}: ${files.join(", ")} (${KNOWN_DUPLICATE_REASONS[version]})\n`);
  }
  for (const [file, reason] of KNOWN_SCHEMA_HARDCODING_EXCEPTIONS) {
    process.stdout.write(`known schema-hardcoding migration exception ${file}: ${reason}\n`);
  }
}

if (!result.ok) {
  process.exitCode = 1;
}
