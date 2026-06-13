import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { buildKnowledgeDocumentId, mapKnowledgeChunkIdToPointId } from "./service";

export type MarkdownLifecycle =
  | "import_current"
  | "archive_obsolete_no_import"
  | "archive_duplicate_no_import"
  | "quarantine_uncertain"
  | "exclude_third_party";

export type MarkdownDocType =
  | "plan"
  | "report"
  | "test_report"
  | "runbook"
  | "status_register"
  | "architecture"
  | "third_party"
  | "unknown";

export interface MarkdownGovernanceCurrentState {
  readonly now: string;
  readonly runtimeOk: boolean;
  readonly candidateCurrent: number;
  readonly qdrantDrift: boolean;
  readonly p1GatePass: boolean;
  readonly productionGuardOk: boolean;
}

export interface MarkdownCandidate {
  readonly path: string;
  readonly relative_path: string;
  readonly size_bytes: number;
  readonly modified_at: string;
  readonly content: string;
  readonly content_hash: string;
}

export interface MarkdownClassification extends Omit<MarkdownCandidate, "content"> {
  readonly lifecycle: MarkdownLifecycle;
  readonly doc_type: MarkdownDocType;
  readonly collection: string | null;
  readonly repo: string;
  readonly classification_reason: string;
  readonly verified_against_current_state: boolean;
}

export interface MarkdownManifestEntry extends MarkdownClassification {
  readonly archived_path: string;
  readonly should_import: boolean;
  readonly should_archive: boolean;
}

export interface KnowledgeMarkdownManifest {
  readonly ok: true;
  readonly run_id: string;
  readonly generated_at: string;
  readonly archive_root: string;
  readonly summary: Record<MarkdownLifecycle | "total" | "should_import" | "should_archive", number>;
  readonly entries: readonly MarkdownManifestEntry[];
}

export interface MarkdownChunk {
  readonly content: string;
  readonly chunk_index: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly content_hash: string;
}

export interface KnowledgeMarkdownDocumentRow {
  readonly id: string;
  readonly collection: string;
  readonly repo: string;
  readonly source_root: string | null;
  readonly source_path: string;
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeMarkdownChunkRow {
  readonly id: string;
  readonly document_id: string;
  readonly collection: string;
  readonly repo: string;
  readonly source_path: string;
  readonly chunk_index: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly embedding_model: string;
  readonly embedding_dimension: number;
  readonly qdrant_point_id: string;
  readonly content_hash: string;
}

export interface KnowledgeMarkdownRows {
  readonly documents: readonly KnowledgeMarkdownDocumentRow[];
  readonly chunks: readonly KnowledgeMarkdownChunkRow[];
}

const DEFAULT_PROJECT_COLLECTION = "project:memory-xx:docs";
const DEFAULT_USER_COLLECTION = "user:current-user:docs";
const DEFAULT_TEST_COLLECTION = "test:evidence";

const EXCLUDED_SEGMENTS = new Set([
  ".cache",
  ".hfenv",
  ".npm-global",
  ".pnpm-store",
  ".venv",
  ".agents",
  ".bun",
  "backups",
  "dist",
  "dist-runtime",
  "node_modules",
  "site-packages",
  "tools",
  "vendor",
]);

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/gu, "/");
}

function pathSegments(value: string): string[] {
  return normalizePathForMatch(value).split("/").filter(Boolean);
}

function isExcludedPath(filePath: string): boolean {
  const normalized = normalizePathForMatch(filePath);
  const segments = pathSegments(normalized);
  if (segments.some((segment) => segment.startsWith(".") && segment.length > 1)) return true;
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  return /\/(?:zhaolocal-full-local-debug|\.local\/lib\/node_modules|\.codex\/(?:plugins\/cache|skills))\b/iu.test(normalized);
}

function repoForPath(filePath: string): string {
  const normalized = normalizePathForMatch(filePath);
  if (/\/services\/memory-xx\//u.test(normalized) || /\/docs\/memory-xx\//u.test(normalized) || /memory-xx/iu.test(normalized)) {
    return "memory-xx";
  }
  if (/\/local\//u.test(normalized)) return "local";
  return "home";
}

function collectionFor(input: { readonly path: string; readonly docType: MarkdownDocType; readonly content: string }): string {
  const text = `${input.path}\n${input.content}`;
  if (/test-project-|api-test|unified-api|test:evidence/iu.test(text)) return DEFAULT_TEST_COLLECTION;
  if (/用户|偏好|current-user|USER\.md/iu.test(text) && !/memory-xx/iu.test(input.path)) return DEFAULT_USER_COLLECTION;
  return DEFAULT_PROJECT_COLLECTION;
}

function docTypeFor(filePath: string, content: string): MarkdownDocType {
  const text = `${filePath}\n${content}`;
  if (isExcludedPath(filePath)) return "third_party";
  if (/open-items-register|Open Items Register|未决项|rollback 窗口观察期/iu.test(text)) return "status_register";
  if (/test-report|测试报告|PASS|FAIL|验收报告|random test|完整测试/iu.test(text)) return "test_report";
  if (/runbook|操作手册|运行手册|health check|journalctl|systemd/iu.test(text)) return "runbook";
  if (/architecture|架构|foundation|design|设计/iu.test(text)) return "architecture";
  if (/计划|方案|plan|implementation checklist|Key Changes|Acceptance Criteria/iu.test(text)) return "plan";
  if (/报告|report|audit|审计|复核|验收/iu.test(text)) return "report";
  return "unknown";
}

function isRecent(candidate: MarkdownCandidate, currentState: MarkdownGovernanceCurrentState, days: number): boolean {
  const modifiedAt = Date.parse(candidate.modified_at);
  const now = Date.parse(currentState.now);
  if (!Number.isFinite(modifiedAt) || !Number.isFinite(now)) return false;
  return now - modifiedAt <= days * 24 * 60 * 60 * 1000;
}

function isExpiredRollbackWindow(content: string, currentState: MarkdownGovernanceCurrentState): boolean {
  const windowMatch = content.match(/(?:至|until|through)\s*(20\d{2}-\d{2}-\d{2})/iu);
  if (!windowMatch) return false;
  const windowEnd = Date.parse(`${windowMatch[1]}T23:59:59.999Z`);
  const now = Date.parse(currentState.now);
  return Number.isFinite(windowEnd) && Number.isFinite(now) && now > windowEnd;
}

function hasClosedStatusRegisterSignal(content: string, currentState: MarkdownGovernanceCurrentState): boolean {
  return /(全部正式闭环|已全部闭环|O-01\s*~\s*O-04.*闭环|GO已签收|已完成)/iu.test(content) &&
    isExpiredRollbackWindow(content, currentState);
}

function hasResolvedRuntimeIssue(content: string, currentState: MarkdownGovernanceCurrentState): boolean {
  if (currentState.qdrantDrift || !currentState.runtimeOk) return false;
  return /(Qdrant|PG).{0,40}(mismatch|不一致|漂移|stale|drift|blocker)/iu.test(content) &&
    /(修复|repair|已解决|resolved|当前.*0|drift\s*=\s*0)/iu.test(content);
}

function hasCurrentOperationalValue(candidate: MarkdownCandidate, docType: MarkdownDocType, currentState: MarkdownGovernanceCurrentState): boolean {
  const text = candidate.content;
  if (docType === "test_report") {
    return isRecent(candidate, currentState, 14) && /(PASS|FAIL|测试|验收|MCP|filter_mode|Qdrant|pending|runtime_ok)/iu.test(text);
  }
  if (docType === "runbook") {
    return /(当前|current|正确方式|修复命令|runbook|systemd|Qdrant|pending|memory:)/iu.test(text);
  }
  if (docType === "architecture") {
    return /memory-xx|Postgres|Qdrant|Redis|recall|policy|knowledge/iu.test(text);
  }
  if (docType === "report") {
    return isRecent(candidate, currentState, 30) && /(runtime_ok|candidate_current|Qdrant drift|production guard|P1 gate|default_leakage)/iu.test(text);
  }
  if (docType === "plan") {
    return isRecent(candidate, currentState, 10) && /(未完成|下一步|当前|canary|pending|knowledge|自动审批|实现计划)/iu.test(text);
  }
  return false;
}

export function classifyMarkdownDocument(
  candidate: MarkdownCandidate,
  currentState: MarkdownGovernanceCurrentState,
): MarkdownClassification {
  const { content: candidateContent, ...candidateWithoutContent } = candidate;
  const docType = docTypeFor(candidate.path, candidate.content);
  const repo = repoForPath(candidate.path);
  if (docType === "third_party") {
    return {
      ...candidateWithoutContent,
      lifecycle: "exclude_third_party",
      doc_type: "third_party",
      collection: null,
      repo,
      classification_reason: "excluded_path",
      verified_against_current_state: false,
    };
  }

  if (docType === "status_register" && hasClosedStatusRegisterSignal(candidate.content, currentState)) {
    return {
      ...candidateWithoutContent,
      lifecycle: "archive_obsolete_no_import",
      doc_type: docType,
      collection: null,
      repo,
      classification_reason: "closed_or_expired_status_register",
      verified_against_current_state: true,
    };
  }

  if (hasResolvedRuntimeIssue(candidate.content, currentState) && !isRecent(candidate, currentState, 14)) {
    return {
      ...candidateWithoutContent,
      lifecycle: "archive_obsolete_no_import",
      doc_type: docType,
      collection: null,
      repo,
      classification_reason: "resolved_runtime_issue_obsolete",
      verified_against_current_state: true,
    };
  }

  if (hasCurrentOperationalValue(candidate, docType, currentState)) {
    return {
      ...candidateWithoutContent,
      lifecycle: "import_current",
      doc_type: docType,
      collection: collectionFor({ path: candidate.path, docType, content: candidateContent }),
      repo,
      classification_reason: docType === "test_report" ? "recent_test_report_with_actionable_evidence" : "current_operational_document",
      verified_against_current_state: true,
    };
  }

  return {
    ...candidateWithoutContent,
    lifecycle: "quarantine_uncertain",
    doc_type: docType,
    collection: null,
    repo,
    classification_reason: "insufficient_current_project_signal",
    verified_against_current_state: false,
  };
}

function topicKey(item: MarkdownClassification): string | null {
  const normalized = normalizePathForMatch(item.relative_path).toLowerCase();
  if (/recall|召回/u.test(normalized)) return "memory-xx:recall";
  if (/auto-approval|自动审批|policy/u.test(normalized)) return "memory-xx:auto-approval";
  if (/qdrant|embedding/u.test(normalized)) return "memory-xx:qdrant-embedding";
  if (/functionality-gap|gap-assessment|落地差距/u.test(normalized)) return "memory-xx:gap";
  return null;
}

export function classifyMarkdownDocuments(
  candidates: readonly MarkdownCandidate[],
  currentState: MarkdownGovernanceCurrentState,
): MarkdownClassification[] {
  const classified = candidates.map((item) => classifyMarkdownDocument(item, currentState));
  const newestImportReport = classified
    .filter((item) => item.lifecycle === "import_current" && (item.doc_type === "report" || item.doc_type === "test_report"))
    .sort((a, b) => Date.parse(b.modified_at) - Date.parse(a.modified_at))[0];
  const importByTopic = new Map<string, MarkdownClassification>();
  for (const item of classified) {
    const key = topicKey(item);
    if (!key || item.lifecycle !== "import_current") continue;
    const existing = importByTopic.get(key);
    if (!existing || Date.parse(item.modified_at) > Date.parse(existing.modified_at)) {
      importByTopic.set(key, item);
    }
  }
  return classified.map((item) => {
    const key = topicKey(item);
    const covering = key ? importByTopic.get(key) : undefined;
    if (
      ((covering && covering.path !== item.path) || (newestImportReport && newestImportReport.path !== item.path)) &&
      item.lifecycle === "quarantine_uncertain" &&
      item.doc_type === "plan" &&
      Date.parse(item.modified_at) < Date.parse((covering ?? newestImportReport)!.modified_at)
    ) {
      return {
        ...item,
        lifecycle: "archive_duplicate_no_import",
        classification_reason: "superseded_by_newer_memory_xx_report",
        verified_against_current_state: true,
      };
    }
    return item;
  });
}

export async function scanMarkdownFiles(input: {
  readonly root: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}): Promise<MarkdownCandidate[]> {
  const root = path.resolve(input.root);
  const maxFiles = Math.max(1, input.maxFiles ?? 2000);
  const maxBytes = Math.max(1024, input.maxBytes ?? 512 * 1024);
  const results: MarkdownCandidate[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxFiles || isExcludedPath(dir)) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);
      if (isExcludedPath(fullPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const info = await stat(fullPath);
      if (info.size > maxBytes) continue;
      const content = await readFile(fullPath, "utf8").catch(() => "");
      if (!content.trim()) continue;
      results.push({
        path: fullPath,
        relative_path: normalizePathForMatch(path.relative(root, fullPath)),
        size_bytes: info.size,
        modified_at: info.mtime.toISOString(),
        content,
        content_hash: hashString(content),
      });
    }
  }

  await walk(root);
  return results;
}

function summaryFor(entries: readonly MarkdownManifestEntry[]): KnowledgeMarkdownManifest["summary"] {
  const summary: KnowledgeMarkdownManifest["summary"] = {
    total: entries.length,
    import_current: 0,
    archive_obsolete_no_import: 0,
    archive_duplicate_no_import: 0,
    quarantine_uncertain: 0,
    exclude_third_party: 0,
    should_import: 0,
    should_archive: 0,
  };
  for (const entry of entries) {
    summary[entry.lifecycle] += 1;
    if (entry.should_import) summary.should_import += 1;
    if (entry.should_archive) summary.should_archive += 1;
  }
  return summary;
}

export function buildKnowledgeMarkdownManifest(input: {
  readonly runId: string;
  readonly generatedAt: string;
  readonly archiveRoot: string;
  readonly classifications: readonly MarkdownClassification[];
}): KnowledgeMarkdownManifest {
  const archiveRoot = path.resolve(input.archiveRoot);
  const entries = input.classifications.map((item) => {
    const archivedPath = path.join(archiveRoot, input.runId, item.relative_path);
    const shouldImport = item.lifecycle === "import_current";
    return {
      ...item,
      archived_path: archivedPath,
      should_import: shouldImport,
      should_archive: shouldImport || item.lifecycle === "archive_obsolete_no_import" || item.lifecycle === "archive_duplicate_no_import",
    };
  });
  return {
    ok: true,
    run_id: input.runId,
    generated_at: input.generatedAt,
    archive_root: archiveRoot,
    summary: summaryFor(entries),
    entries,
  };
}

export function chunkMarkdownDocument(input: {
  readonly path: string;
  readonly content: string;
  readonly maxChars?: number;
}): MarkdownChunk[] {
  const maxChars = Math.max(200, input.maxChars ?? 1800);
  const lines = input.content.split(/\r?\n/u);
  const chunks: MarkdownChunk[] = [];
  let buffer: string[] = [];
  let startLine = 1;

  function flush(endLine: number): void {
    const content = buffer.join("\n").trim();
    if (!content) return;
    chunks.push({
      content,
      chunk_index: chunks.length,
      start_line: startLine,
      end_line: endLine,
      content_hash: hashString(content),
    });
    buffer = [];
    startLine = endLine + 1;
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const next = [...buffer, line].join("\n");
    if (buffer.length > 0 && next.length > maxChars && /^#{1,6}\s+/u.test(line)) {
      flush(index);
    }
    buffer.push(line);
    if (buffer.join("\n").length >= maxChars) {
      flush(index + 1);
    }
  }
  flush(lines.length);
  return chunks;
}

export function buildKnowledgeMarkdownRows(input: {
  readonly entries: ReadonlyArray<MarkdownManifestEntry & { readonly content: string }>;
  readonly ingestRunId: string;
}): KnowledgeMarkdownRows {
  const documents: KnowledgeMarkdownDocumentRow[] = [];
  const chunks: KnowledgeMarkdownChunkRow[] = [];
  for (const entry of input.entries) {
    if (entry.lifecycle !== "import_current" || !entry.collection) continue;
    const documentId = buildKnowledgeDocumentId(entry.collection, entry.relative_path);
    const metadata = {
      doc_lifecycle: entry.lifecycle,
      doc_type: entry.doc_type,
      source_path: entry.path,
      archived_path: entry.archived_path,
      content_hash: entry.content_hash,
      classification_reason: entry.classification_reason,
      verified_against_current_state: entry.verified_against_current_state,
      ingest_run_id: input.ingestRunId,
    };
    documents.push({
      id: documentId,
      collection: entry.collection,
      repo: entry.repo,
      source_root: null,
      source_path: entry.relative_path,
      metadata,
    });
    for (const chunk of chunkMarkdownDocument({ path: entry.path, content: entry.content })) {
      const chunkId = hashString(`${entry.collection}:${entry.relative_path}:${chunk.chunk_index}:${chunk.content_hash}`).slice(0, 48);
      chunks.push({
        id: chunkId,
        document_id: documentId,
        collection: entry.collection,
        repo: entry.repo,
        source_path: entry.relative_path,
        chunk_index: chunk.chunk_index,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        content: chunk.content,
        metadata,
        embedding_model: process.env.EMBEDDING_MODEL?.trim() || "memory-xx-dev-embedding",
        embedding_dimension: 4096,
        qdrant_point_id: mapKnowledgeChunkIdToPointId(chunkId),
        content_hash: chunk.content_hash,
      });
    }
  }
  return { documents, chunks };
}

export async function executeMarkdownArchivePlan(input: {
  readonly manifest: KnowledgeMarkdownManifest;
  readonly apply: boolean;
}): Promise<{
  readonly planned: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly moved: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly skipped: ReadonlyArray<{ readonly from: string; readonly reason: string }>;
}> {
  const planned = input.manifest.entries
    .filter((entry) => entry.should_archive)
    .map((entry) => ({ from: entry.path, to: entry.archived_path }));
  const moved: Array<{ readonly from: string; readonly to: string }> = [];
  const skipped: Array<{ readonly from: string; readonly reason: string }> = [];
  if (!input.apply) return { planned, moved, skipped };

  for (const item of planned) {
    try {
      await mkdir(path.dirname(item.to), { recursive: true });
      await copyFile(item.from, item.to);
      await unlink(item.from);
      moved.push(item);
    } catch (error) {
      skipped.push({ from: item.from, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { planned, moved, skipped };
}
