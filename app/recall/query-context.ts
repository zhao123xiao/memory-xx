import { tokenizeRecallQuery } from "./metadata-filter-builder";
import type { RecallQueryContext, RecallRequest } from "./types";

const TOKEN_CAP = 256;
const CHAR_CAP = 500;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function trimToCharCap(value: string): string {
  return value.length <= CHAR_CAP ? value : value.slice(0, CHAR_CAP);
}

export function buildRecallQueryContext(request: RecallRequest): RecallQueryContext {
  const contextQueries = unique((request.context_queries ?? []).slice(-3));
  const taskId = request.task_id ?? request.scope_context.runtime?.task_id;
  const sessionId = request.session_id ?? request.scope_context.runtime?.session_id ?? request.scope_context.runtime?.run_id;
  const contextParts = [
    request.query,
    ...contextQueries,
    request.current_goal,
    taskId
  ].filter((part): part is string => typeof part === "string" && part.trim() !== "");
  const expanded = contextParts.length > 1;
  const expandedQuery = expanded ? trimToCharCap(contextParts.join(" ")) : undefined;
  const terms = tokenizeRecallQuery(expandedQuery ?? request.query).slice(0, TOKEN_CAP);

  return {
    original_query: request.query,
    expanded_query: expandedQuery,
    context_queries: contextQueries,
    current_goal: request.current_goal,
    task_id: taskId,
    session_id: sessionId,
    turn_id: request.turn_id,
    expanded,
    token_cap: TOKEN_CAP,
    char_cap: CHAR_CAP,
    terms
  };
}
