import type { JsonObject } from "../shared/types";

const GLOBAL_MEMORY_INTENT_PATTERNS: readonly RegExp[] = [
  /(?:写进|写入|记到|保存到|存到|同步到|加入|添加到)\s*(?:全局|global)\s*(?:记忆|memory)?/iu,
  /(?:这条|这个|该内容|以下内容|本规则).{0,30}(?:作为|当作|设为)?\s*(?:全局|global)\s*(?:记忆|memory|规则|约束)/iu,
  /(?:全局|global)\s*(?:记忆|memory).{0,30}(?:写进|写入|记录|保存|更新|替换|改成|改为)/iu,
  /\b(?:write|save|store|record|update)\s+(?:this\s+)?(?:to|as|into)\s+global\s+memory\b/iu,
  /\bglobal\s+memory\b.{0,40}\b(?:write|save|store|record|update|replace|supersede)\b/iu,
];

function metadataText(metadata: JsonObject | null | undefined): string {
  if (!metadata) return "";
  const values: string[] = [];
  for (const key of [
    "source_text",
    "sourceText",
    "raw_text",
    "rawText",
    "user_text",
    "userText",
    "intent",
    "memory_intent",
    "global_intent",
  ]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  return values.join("\n");
}

export function hasExplicitGlobalMemoryIntent(...texts: readonly (string | null | undefined)[]): boolean {
  const text = texts.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n");
  if (!text.trim()) return false;
  return GLOBAL_MEMORY_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasExplicitGlobalMemoryIntentFromMetadata(metadata: JsonObject | null | undefined): boolean {
  return hasExplicitGlobalMemoryIntent(metadataText(metadata));
}
