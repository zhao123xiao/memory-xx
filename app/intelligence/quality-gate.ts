export interface ExtractionQualityGateInput {
  readonly inputText: string;
  readonly canonicalContent: string;
}

export interface ExtractionQualityGateResult {
  readonly score: number;
  readonly passed: boolean;
  readonly action: "continue" | "candidate_pending" | "buffer";
  readonly flags: readonly string[];
  readonly penalties: {
    readonly meta_phrase: number;
    readonly length_ratio: number;
    readonly expansion_risk: number;
  };
  readonly length_ratio: number;
  readonly boundary: "short" | "normal" | "long";
}

const META_PHRASE_RE =
  /(?:记住|记得|用户说|系统要求|请把|不要把这句话|the user says|user said|system requires|remember this)/iu;
const ACRONYM_RE = /\b[A-Z][A-Z0-9/+-]{1,}\b/g;
const QUOTED_TERM_RE = /["“”'‘’]([^"“”'‘’]{2,40})["“”'‘’]/gu;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueMatches(input: string, pattern: RegExp): string[] {
  const matches = new Set<string>();
  for (const match of input.matchAll(pattern)) {
    const value = (match[1] ?? match[0] ?? "").trim();
    if (value) matches.add(value);
  }
  return [...matches];
}

function countNewExpansionTerms(inputText: string, canonicalContent: string): {
  readonly newAcronyms: number;
  readonly newQuotedTerms: number;
} {
  const input = normalizedText(inputText);
  const newAcronyms = uniqueMatches(canonicalContent, ACRONYM_RE)
    .filter((term) => !input.includes(term.toLowerCase())).length;
  const newQuotedTerms = uniqueMatches(canonicalContent, QUOTED_TERM_RE)
    .filter((term) => !input.includes(term.toLowerCase())).length;
  return { newAcronyms, newQuotedTerms };
}

function isShortCjkToEnglish(original: string, canonical: string): boolean {
  return original.length < 20 &&
    /[\u3400-\u9fff]/u.test(original) &&
    /[a-z]/iu.test(canonical) &&
    !/[\u3400-\u9fff]/u.test(canonical);
}

export function evaluateExtractionQuality(input: ExtractionQualityGateInput): ExtractionQualityGateResult {
  const original = input.inputText.trim();
  const canonical = input.canonicalContent.trim();
  const originalLength = Math.max(1, original.length);
  const lengthRatio = canonical.length / originalLength;
  const flags: string[] = [];
  let score = 1.0;

  const metaPhrase = META_PHRASE_RE.test(canonical);
  if (metaPhrase) {
    flags.push("meta_phrase");
    score -= 0.30;
  }

  const boundary: "short" | "normal" | "long" =
    original.length < 20 ? "short" : original.length <= 200 ? "normal" : "long";
  const crossLanguageRelaxed = isShortCjkToEnglish(original, canonical);
  const lengthAnomaly =
    boundary === "short"
      ? lengthRatio > (crossLanguageRelaxed ? 6 : 3)
      : boundary === "normal"
        ? lengthRatio > 1.15
        : lengthRatio < 0.7 || lengthRatio > 1.3;
  if (crossLanguageRelaxed) {
    flags.push("cross_language_length_ratio_relaxed");
  }
  if (lengthAnomaly) {
    flags.push("length_ratio");
    score -= 0.25;
  }

  const expansion = countNewExpansionTerms(original, canonical);
  const expansionRisk = expansion.newAcronyms >= 2 || expansion.newQuotedTerms >= 2;
  if (expansionRisk) {
    flags.push("expansion_risk");
    score -= 0.20;
  }

  const finalScore = clamp01(score);
  const action =
    finalScore >= 0.75 ? "continue" : finalScore >= 0.60 ? "candidate_pending" : "buffer";

  return {
    score: finalScore,
    passed: finalScore >= 0.75,
    action,
    flags,
    penalties: {
      meta_phrase: metaPhrase ? 0.30 : 0,
      length_ratio: lengthAnomaly ? 0.25 : 0,
      expansion_risk: expansionRisk ? 0.20 : 0,
    },
    length_ratio: Number(lengthRatio.toFixed(4)),
    boundary,
  };
}

export function combineQualityGates(results: readonly ExtractionQualityGateResult[]): ExtractionQualityGateResult | undefined {
  if (results.length === 0) return undefined;
  return results.reduce((lowest, current) => current.score < lowest.score ? current : lowest);
}
