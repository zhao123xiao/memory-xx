import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type CodeGraphNodeType = "repository" | "file" | "symbol" | "external";

export interface CodeGraphNode {
  readonly id: string;
  readonly type: CodeGraphNodeType;
  readonly label: string;
  readonly subtitle: string;
  readonly score: number;
  readonly metadata: Record<string, unknown>;
}

export interface CodeGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly label: string;
  readonly weight: number;
  readonly metadata?: Record<string, unknown>;
}

export interface CodeGraph {
  readonly generated_at: string;
  readonly root: string;
  readonly project_id: string;
  readonly snapshot_id: string;
  readonly nodes: readonly CodeGraphNode[];
  readonly edges: readonly CodeGraphEdge[];
  readonly summary: Record<string, unknown>;
}

export interface BuildCodeGraphOptions {
  readonly root?: string;
  readonly projectId?: string;
  readonly maxFiles?: number;
  readonly includeTests?: boolean;
}

export interface FilterCodeGraphOptions {
  readonly query?: string;
  readonly limit?: number;
  readonly edgeLimit?: number;
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs"
]);

const IGNORE_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage",
  "backups", "reports", "migration_artifacts", ".next", ".cache", "target",
  "__pycache__", ".venv", "venv"
]);

const CALL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof",
  "sizeof", "new", "class", "super", "import", "require", "describe", "test",
  "it", "expect", "assert", "console"
]);

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function listCodeFiles(root: string, maxFiles: number, includeTests: boolean): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= maxFiles) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!CODE_EXTENSIONS.has(ext)) continue;
      const rel = toPosix(path.relative(root, full));
      if (!includeTests && /(^|\/)(tests?|__tests__|fixtures?)\//u.test(rel)) continue;
      files.push(rel);
    }
  };
  visit(root);
  return files.sort();
}

function pushNode(nodes: Map<string, CodeGraphNode>, node: CodeGraphNode): void {
  const existing = nodes.get(node.id);
  if (!existing || node.score > existing.score) nodes.set(node.id, node);
}

function pushEdge(edges: Map<string, CodeGraphEdge>, edge: CodeGraphEdge): void {
  if (edge.source === edge.target) return;
  if (!edges.has(edge.id)) edges.set(edge.id, edge);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/u).length;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1 ")
    .replace(/#.*$/gmu, " ");
}

function symbolId(file: string, name: string): string {
  return `symbol:${file}#${name}`;
}

function fileId(file: string): string {
  return `file:${file}`;
}

function externalId(specifier: string): string {
  return `external:${specifier}`;
}

function addDeclarations(input: {
  readonly root: string;
  readonly rel: string;
  readonly text: string;
  readonly nodes: Map<string, CodeGraphNode>;
  readonly edges: Map<string, CodeGraphEdge>;
  readonly symbolByName: Map<string, string[]>;
}): void {
  const ext = path.extname(input.rel);
  const patterns: Array<{ kind: string; re: RegExp }> = [
    { kind: "function", re: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu },
    { kind: "class", re: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/gu },
    { kind: "interface", re: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/gu },
    { kind: "type", re: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/gu },
    { kind: "enum", re: /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/gu },
    { kind: "export", re: /\bexport\s+const\s+([A-Za-z_$][\w$]*)\b/gu },
  ];
  if (ext === ".py") {
    patterns.push(
      { kind: "function", re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gmu },
      { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)\b/gmu },
    );
  }
  if (ext === ".go") {
    patterns.push(
      { kind: "function", re: /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/gu },
      { kind: "type", re: /\btype\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/gu },
    );
  }
  if (ext === ".rs") {
    patterns.push(
      { kind: "function", re: /\b(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/gu },
      { kind: "type", re: /\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)\b/gu },
    );
  }
  if ([".java", ".kt", ".kts", ".cs"].includes(ext)) {
    patterns.push({ kind: "class", re: /\b(?:public|private|protected|internal|abstract|final|static|\s)*\s*(?:class|interface|enum)\s+([A-Za-z_][\w]*)\b/gu });
  }

  const seen = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(input.text))) {
      const name = match[1];
      if (!name || seen.has(`${pattern.kind}:${name}`)) continue;
      seen.add(`${pattern.kind}:${name}`);
      const id = symbolId(input.rel, name);
      pushNode(input.nodes, {
        id,
        type: "symbol",
        label: name,
        subtitle: `${pattern.kind} | ${input.rel}`,
        score: pattern.kind === "class" ? 72 : 64,
        metadata: {
          kind: pattern.kind,
          file: input.rel,
          line: lineOf(input.text, match.index),
        },
      });
      pushEdge(input.edges, {
        id: `declares:${input.rel}:${name}`,
        source: fileId(input.rel),
        target: id,
        type: "declares",
        label: "declares",
        weight: 0.75,
      });
      const list = input.symbolByName.get(name) ?? [];
      list.push(id);
      input.symbolByName.set(name, list);
    }
  }
}

function extractImports(text: string, ext: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/gu,
    /\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  if (ext === ".py") {
    patterns.push(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gmu, /^\s*import\s+([A-Za-z0-9_.,\s]+)/gmu);
  }
  if (ext === ".go") {
    patterns.push(/\bimport\s+"([^"]+)"/gu, /^\s*"([^"]+)"$/gmu);
  }
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      for (const part of String(match[1] ?? "").split(",")) {
        const spec = part.trim().split(/\s+/u)[0];
        if (spec) specs.add(spec);
      }
    }
  }
  return [...specs].slice(0, 80);
}

function resolveRelativeImport(fromRel: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const fromDir = path.posix.dirname(fromRel);
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [
    base,
    ...[...CODE_EXTENSIONS].map((ext) => `${base}${ext}`),
    ...[...CODE_EXTENSIONS].map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function packageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

function addImports(input: {
  readonly rel: string;
  readonly text: string;
  readonly fileSet: Set<string>;
  readonly nodes: Map<string, CodeGraphNode>;
  readonly edges: Map<string, CodeGraphEdge>;
}): void {
  const specs = extractImports(input.text, path.extname(input.rel));
  for (const spec of specs) {
    const resolved = resolveRelativeImport(input.rel, spec, input.fileSet);
    if (resolved) {
      pushEdge(input.edges, {
        id: `imports:${input.rel}:${resolved}`,
        source: fileId(input.rel),
        target: fileId(resolved),
        type: "imports",
        label: "imports",
        weight: 0.82,
        metadata: { specifier: spec },
      });
      continue;
    }
    const pkg = packageName(spec);
    const id = externalId(pkg);
    pushNode(input.nodes, {
      id,
      type: "external",
      label: pkg,
      subtitle: "external package",
      score: 26,
      metadata: { specifier: spec },
    });
    pushEdge(input.edges, {
      id: `imports:${input.rel}:${pkg}`,
      source: fileId(input.rel),
      target: id,
      type: "imports_external",
      label: "imports",
      weight: 0.36,
      metadata: { specifier: spec },
    });
  }
}

function addCalls(input: {
  readonly rel: string;
  readonly text: string;
  readonly symbolByName: Map<string, string[]>;
  readonly edges: Map<string, CodeGraphEdge>;
}): void {
  const clean = stripComments(input.text);
  const calls = new Set<string>();
  let match: RegExpExecArray | null;
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/gu;
  while ((match = re.exec(clean))) {
    const name = match[1];
    if (!name || CALL_SKIP.has(name)) continue;
    calls.add(name);
    if (calls.size >= 120) break;
  }
  for (const name of calls) {
    const targets = input.symbolByName.get(name);
    if (!targets?.length) continue;
    const local = targets.find((target) => target.startsWith(`symbol:${input.rel}#`));
    const target = local ?? (targets.length === 1 ? targets[0] : null);
    if (!target) continue;
    pushEdge(input.edges, {
      id: `calls:${input.rel}:${target}`,
      source: fileId(input.rel),
      target,
      type: "calls",
      label: "calls",
      weight: 0.48,
    });
  }
}

export function buildCodeGraph(options: BuildCodeGraphOptions = {}): CodeGraph {
  const root = path.resolve(options.root ?? process.cwd());
  const projectId = options.projectId?.trim() || path.basename(root) || "unknown-project";
  const generatedAt = new Date().toISOString();
  const maxFiles = Math.max(1, Math.min(2000, Math.trunc(options.maxFiles ?? 500)));
  const files = listCodeFiles(root, maxFiles, options.includeTests ?? true);
  const fileSet = new Set(files);
  const nodes = new Map<string, CodeGraphNode>();
  const edges = new Map<string, CodeGraphEdge>();
  const symbolByName = new Map<string, string[]>();

  pushNode(nodes, {
    id: "repository:root",
    type: "repository",
    label: path.basename(root) || root,
    subtitle: root,
    score: 100,
    metadata: { root },
  });

  const textByFile = new Map<string, string>();
  for (const rel of files) {
    const full = path.join(root, rel);
    const text = safeRead(full);
    textByFile.set(rel, text);
    const stat = statSync(full);
    pushNode(nodes, {
      id: fileId(rel),
      type: "file",
      label: path.posix.basename(rel),
      subtitle: rel,
      score: Math.max(30, Math.min(80, 80 - rel.split("/").length * 3)),
      metadata: {
        path: rel,
        extension: path.extname(rel),
        bytes: stat.size,
        lines: text.split(/\r?\n/u).length,
      },
    });
    pushEdge(edges, {
      id: `contains:root:${rel}`,
      source: "repository:root",
      target: fileId(rel),
      type: "contains",
      label: "contains",
      weight: 0.22,
    });
    addDeclarations({ root, rel, text, nodes, edges, symbolByName });
  }

  for (const rel of files) {
    const text = textByFile.get(rel) ?? "";
    addImports({ rel, text, fileSet, nodes, edges });
  }
  for (const rel of files) {
    const text = textByFile.get(rel) ?? "";
    addCalls({ rel, text, symbolByName, edges });
  }

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  return {
    generated_at: generatedAt,
    root,
    project_id: projectId,
    snapshot_id: `code_graph:${projectId}:${Date.now().toString(36)}`,
    nodes: nodeList,
    edges: edgeList,
    summary: {
      code_graph_project_id: projectId,
      code_graph_scope: `project:${projectId}`,
      memory_scope_type: "project",
      memory_scope_id: projectId,
      generated_at: generatedAt,
      files: files.length,
      symbols: nodeList.filter((node) => node.type === "symbol").length,
      external_packages: nodeList.filter((node) => node.type === "external").length,
      imports: edgeList.filter((edge) => edge.type.startsWith("imports")).length,
      calls: edgeList.filter((edge) => edge.type === "calls").length,
      edges: edgeList.length,
    },
  };
}

function searchable(node: CodeGraphNode): string {
  return [
    node.label,
    node.subtitle,
    node.metadata.path,
    node.metadata.file,
    node.metadata.kind,
    node.metadata.specifier,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function filterCodeGraph(graph: CodeGraph, options: FilterCodeGraphOptions = {}): CodeGraph {
  const limit = Math.max(1, Math.min(400, Math.trunc(options.limit ?? 120)));
  const edgeLimit = Math.max(20, Math.min(800, Math.trunc(options.edgeLimit ?? limit * 3)));
  const query = options.query?.trim().toLowerCase() ?? "";
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const selected = new Set<string>();
  const direct = new Set<string>();

  if (query) {
    for (const node of graph.nodes) {
      if (searchable(node).includes(query)) {
        selected.add(node.id);
        direct.add(node.id);
      }
    }
  } else {
    for (const node of [...graph.nodes].sort((a, b) => b.score - a.score).slice(0, limit)) {
      selected.add(node.id);
      direct.add(node.id);
    }
  }

  for (const edge of graph.edges) {
    if (direct.has(edge.source) || direct.has(edge.target)) {
      selected.add(edge.source);
      selected.add(edge.target);
    }
    if (selected.size >= limit * 2) break;
  }

  const nodes = [...selected]
    .map((id) => nodeMap.get(id))
    .filter((node): node is CodeGraphNode => Boolean(node))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const allowed = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => allowed.has(edge.source) && allowed.has(edge.target))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, edgeLimit);

  return {
    ...graph,
    nodes,
    edges,
    summary: {
      ...graph.summary,
      filtered_nodes: nodes.length,
      filtered_edges: edges.length,
      query: query || null,
    },
  };
}
