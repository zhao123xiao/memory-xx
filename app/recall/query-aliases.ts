import { QueryType } from "./types";

export type AliasMarkerField =
  | "title"
  | "source_path"
  | "content"
  | "section_path"
  | "matched_terms";

export interface QueryAliasTargetMarker {
  readonly field: AliasMarkerField;
  readonly values: readonly string[];
  readonly match?: "includes" | "exact";
}

export interface QueryAliasGroupConfig {
  readonly key: string;
  readonly aliases: readonly string[];
  readonly bonus: number;
  readonly target_markers: readonly QueryAliasTargetMarker[];
  readonly document_lookup_source_path_ok?: boolean;
}

export interface ResolvedDocumentAliasTargets {
  readonly alias_keys: readonly string[];
  readonly title_queries: readonly string[];
  readonly source_path_queries: readonly string[];
  readonly section_queries: readonly string[];
}

export interface ExactMatchBonusConfig {
  readonly exact_title_match_bonus: number;
  readonly exact_memory_id_match_bonus: number;
  readonly source_path_match_bonus: number;
  readonly section_header_match_bonus: number;
}

export interface CanonicalSortBonusConfig {
  readonly canonical_source_paths: readonly string[];
  readonly canonical_source_path_bonus: number;
  readonly canonical_exact_match_bonus: number;
  readonly same_title_canonical_bonus: number;
  readonly canonical_status_memory_types: readonly string[];
  readonly canonical_status_row_bonus: number;
  readonly daily_log_penalty: number;
  readonly non_timeline_daily_log_query_types: readonly QueryType[];
}

export interface RecallRerankConfig {
  readonly exact_match_bonus: ExactMatchBonusConfig;
  readonly alias_groups: readonly QueryAliasGroupConfig[];
  readonly canonical_sort_bonus: CanonicalSortBonusConfig;
}

export const RECALL_RERANK_CONFIG: RecallRerankConfig = {
  exact_match_bonus: {
    exact_title_match_bonus: 0.48,
    exact_memory_id_match_bonus: 0.52,
    source_path_match_bonus: 0.44,
    section_header_match_bonus: 0.34
  },
  alias_groups: [
    {
      key: "primary-ledger",
      aliases: ["主账"],
      bonus: 0.2,
      target_markers: [
        {
          field: "content",
          values: ["主账", "source of truth", "markdown 文件主账"]
        },
        {
          field: "title",
          values: ["System Decisions", "facts.md", "decisions.md"]
        },
        {
          field: "source_path",
          values: ["MEMORY.md", "memory/facts.md", "memory/decisions.md"]
        }
      ]
    },
    {
      key: "go-no-go",
      aliases: ["go-no-go", "go no go", "go-live decision"],
      bonus: 0.18,
      target_markers: [
        {
          field: "content",
          values: ["go-no-go", "go no go", "go-live", "上线决策", "上线判断"]
        },
        {
          field: "title",
          values: ["decisions.md", "System Decisions"]
        }
      ]
    },
    {
      key: "rollback",
      aliases: ["rollback", "回滚", "rollback window", "legacy"],
      bonus: 0.22,
      target_markers: [
        {
          field: "content",
          values: ["rollback", "回滚", "rollback window", "legacy", "回退"]
        },
        {
          field: "title",
          values: ["decisions.md", "lessons.md", "System Decisions"]
        },
        {
          field: "matched_terms",
          values: ["rollback", "回滚", "legacy"]
        }
      ]
    },
    {
      key: "runtime-environment",
      aliases: ["运行环境", "环境事实", "当前环境"],
      bonus: 0.18,
      target_markers: [
        {
          field: "content",
          values: ["运行环境", "环境事实", "当前环境", "runtime", "host"]
        },
        {
          field: "title",
          values: ["facts.md"]
        },
        {
          field: "source_path",
          values: ["memory/facts.md"]
        }
      ]
    },
    {
      key: "lessons",
      aliases: ["lessons", "教训", "踩坑"],
      bonus: 0.18,
      target_markers: [
        {
          field: "title",
          values: ["lessons.md"]
        },
        {
          field: "source_path",
          values: ["memory/lessons.md"]
        },
        {
          field: "content",
          values: ["lessons", "教训", "踩坑", "复盘"]
        }
      ]
    },
    {
      key: "facts",
      aliases: ["facts", "facts.md"],
      bonus: 0.16,
      document_lookup_source_path_ok: true,
      target_markers: [
        {
          field: "title",
          values: ["facts.md"]
        },
        {
          field: "source_path",
          values: ["memory/facts.md"]
        },
        {
          field: "section_path",
          values: ["facts.md"]
        }
      ]
    },
    {
      key: "decisions",
      aliases: ["decisions", "decisions.md"],
      bonus: 0.16,
      document_lookup_source_path_ok: true,
      target_markers: [
        {
          field: "title",
          values: ["decisions.md", "System Decisions"]
        },
        {
          field: "source_path",
          values: ["memory/decisions.md", "MEMORY.md"]
        },
        {
          field: "section_path",
          values: ["decisions.md", "System Decisions"]
        }
      ]
    },
    {
      key: "constraints",
      aliases: ["constraints", "constraints.md", "core constraints"],
      bonus: 0.18,
      document_lookup_source_path_ok: true,
      target_markers: [
        {
          field: "title",
          values: ["constraints.md", "Core Constraints"]
        },
        {
          field: "source_path",
          values: ["memory/constraints.md", "MEMORY.md"]
        },
        {
          field: "section_path",
          values: ["constraints.md", "Core Constraints"]
        }
      ]
    },
    {
      key: "preferences",
      aliases: ["preferences", "preferences.md"],
      bonus: 0.16,
      target_markers: [
        {
          field: "title",
          values: ["preferences.md"]
        },
        {
          field: "source_path",
          values: ["memory/preferences.md"]
        },
        {
          field: "section_path",
          values: ["preferences.md"]
        }
      ]
    },
    {
      key: "memory-system",
      aliases: ["memory-system", "记忆系统"],
      bonus: 0.24,
      target_markers: [
        {
          field: "title",
          values: ["memory-system", "项目：memory-system"]
        },
        {
          field: "source_path",
          values: ["memory/projects.md"]
        },
        {
          field: "content",
          values: ["memory-system", "记忆系统"]
        }
      ]
    },
    {
      key: "multi-agent-mode",
      aliases: ["multi-agent-mode", "多 agent", "multi agent"],
      bonus: 0.24,
      target_markers: [
        {
          field: "title",
          values: ["multi-agent-mode", "项目：multi-agent-mode"]
        },
        {
          field: "source_path",
          values: ["memory/projects.md"]
        },
        {
          field: "content",
          values: ["multi-agent-mode", "多 agent", "multi agent"]
        }
      ]
    },
    {
      key: "memory-framework-9.5-execution",
      aliases: [
        "memory-framework-9.5-execution",
        "记忆框架 9.5",
        "memory framework 9.5"
      ],
      bonus: 0.24,
      target_markers: [
        {
          field: "title",
          values: [
            "memory-framework-9.5-execution",
            "项目：memory-framework-9.5-execution"
          ]
        },
        {
          field: "source_path",
          values: ["memory/projects.md"]
        },
        {
          field: "content",
          values: [
            "memory-framework-9.5-execution",
            "记忆框架 9.5",
            "memory framework 9.5"
          ]
        }
      ]
    },
    {
      key: "project-index",
      aliases: ["project index"],
      bonus: 0.2,
      document_lookup_source_path_ok: true,
      target_markers: [
        {
          field: "title",
          values: ["Project Index"]
        },
        {
          field: "section_path",
          values: ["Project Index"]
        },
        {
          field: "source_path",
          values: ["MEMORY.md"]
        }
      ]
    },
    {
      key: "system-decisions",
      aliases: ["system decisions"],
      bonus: 0.2,
      document_lookup_source_path_ok: true,
      target_markers: [
        {
          field: "title",
          values: ["System Decisions"]
        },
        {
          field: "section_path",
          values: ["System Decisions"]
        },
        {
          field: "source_path",
          values: ["MEMORY.md"]
        }
      ]
    },
    {
      key: "persona",
      aliases: ["persona"],
      bonus: 0.2,
      document_lookup_source_path_ok: true,
      target_markers: [
        {
          field: "title",
          values: ["Persona"]
        },
        {
          field: "section_path",
          values: ["Persona"]
        },
        {
          field: "source_path",
          values: ["MEMORY.md"]
        }
      ]
    },
    {
      key: "collaboration",
      aliases: ["collaboration"],
      bonus: 0.2,
      document_lookup_source_path_ok: true,
      target_markers: [
        {
          field: "title",
          values: ["Collaboration"]
        },
        {
          field: "section_path",
          values: ["Collaboration"]
        },
        {
          field: "source_path",
          values: ["MEMORY.md"]
        }
      ]
    }
  ],
  canonical_sort_bonus: {
    canonical_source_paths: [
      "memory/projects.md",
      "memory/facts.md",
      "memory/decisions.md",
      "memory/preferences.md",
      "memory/constraints.md",
      "memory/relationships.md",
      "memory/lessons.md",
      "MEMORY.md"
    ],
    canonical_source_path_bonus: 0.16,
    canonical_exact_match_bonus: 0.08,
    same_title_canonical_bonus: 0.06,
    canonical_status_memory_types: ["project-status", "stable-summary"],
    canonical_status_row_bonus: 0.12,
    daily_log_penalty: 0.08,
    non_timeline_daily_log_query_types: [
      QueryType.ExactLookup,
      QueryType.PreferenceLookup,
      QueryType.DecisionLookup,
      QueryType.ProjectContext,
      QueryType.EntityProfile,
      QueryType.ExploratorySemantic,
      QueryType.SourceAudit
    ]
  }
};

export function normalizeComparableText(value: string | undefined | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[“”‘’'"`]/g, "")
    .replace(/[._/\\:-]+/g, " ")
    .replace(/[()\[\]{}（）【】]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSourcePath(value: string | undefined | null): string {
  return (value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

export function basenameSourcePath(value: string | undefined | null): string {
  const normalized = normalizeSourcePath(value);
  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

export function hasCloseHeaderMatch(
  query: string,
  target: string | undefined | null
): boolean {
  const normalizedQuery = normalizeComparableText(query);
  const normalizedTarget = normalizeComparableText(target);

  if (!normalizedQuery || !normalizedTarget) {
    return false;
  }

  if (normalizedQuery === normalizedTarget) {
    return true;
  }

  return (
    normalizedQuery.length >= 6 &&
    normalizedTarget.length >= 6 &&
    (normalizedQuery.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedQuery))
  );
}

export function queryMatchesAlias(
  query: string,
  aliases: readonly string[]
): boolean {
  const normalizedQuery = normalizeComparableText(query);
  if (!normalizedQuery) {
    return false;
  }

  return aliases.some((alias) => {
    const normalizedAlias = normalizeComparableText(alias);
    return Boolean(
      normalizedAlias &&
        (normalizedQuery === normalizedAlias ||
          normalizedQuery.includes(normalizedAlias))
    );
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function resolveDocumentAliasTargets(
  query: string
): ResolvedDocumentAliasTargets {
  const aliasKeys: string[] = [];
  const titleQueries: string[] = [];
  const sourcePathQueries: string[] = [];
  const sectionQueries: string[] = [];

  for (const aliasGroup of RECALL_RERANK_CONFIG.alias_groups) {
    if (!queryMatchesAlias(query, aliasGroup.aliases)) {
      continue;
    }

    let matchedDocumentMarker = false;
    for (const marker of aliasGroup.target_markers) {
      switch (marker.field) {
        case "title":
          titleQueries.push(
            ...marker.values.map((value) => normalizeComparableText(value))
          );
          matchedDocumentMarker = true;
          break;
        case "source_path":
          sourcePathQueries.push(
            ...marker.values.map((value) => normalizeSourcePath(value))
          );
          matchedDocumentMarker = true;
          break;
        case "section_path":
          sectionQueries.push(
            ...marker.values.map((value) => normalizeComparableText(value))
          );
          matchedDocumentMarker = true;
          break;
        default:
          break;
      }
    }

    if (matchedDocumentMarker) {
      aliasKeys.push(aliasGroup.key);
    }
  }

  return {
    alias_keys: unique(aliasKeys),
    title_queries: unique(titleQueries),
    source_path_queries: unique(sourcePathQueries),
    section_queries: unique(sectionQueries)
  };
}

export function isDailyLogSourcePath(value: string | undefined | null): boolean {
  return /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(normalizeSourcePath(value));
}
