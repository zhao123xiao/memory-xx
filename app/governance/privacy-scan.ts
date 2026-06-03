export type PrivacyFindingKind = "secret" | "credential" | "pii" | "internal_path" | "safe";

export interface PrivacyFinding {
  readonly kind: PrivacyFindingKind;
  readonly reason: string;
  readonly severity: "hard" | "soft" | "safe";
}

export interface PrivacyScanResult {
  readonly blocked: boolean;
  readonly findings: readonly PrivacyFinding[];
  readonly reasons: readonly string[];
}

const SAFE_ID_PATTERNS = [
  /\b(?:memory|trace|request|batch|issue|ticket|pr|run|job)[-_:#]?[a-z0-9-]{4,}\b/iu,
  /\b(?:aar|aac|aaf|scope|privacy|temporal|auto-update|closure)-[a-z0-9-]{6,}\b/iu,
  /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
];

function isSafeIdentifier(value: string): boolean {
  return SAFE_ID_PATTERNS.some((pattern) => pattern.test(value));
}

export function scanMemoryPrivacy(text: string): PrivacyScanResult {
  const findings: PrivacyFinding[] = [];
  const value = text.trim();

  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu.test(value)) {
    findings.push({ kind: "secret", reason: "private_key", severity: "hard" });
  }
  if (/\b(?:api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,}/iu.test(value)) {
    findings.push({ kind: "secret", reason: "secret_assignment", severity: "hard" });
  }
  if (/\b(?:api[_-]?key|secret|token)\s+['"]?(?:sk|pk|rk|ghp|github_pat)_[A-Za-z0-9._~+/=-]{12,}\b/iu.test(value)) {
    findings.push({ kind: "secret", reason: "secret_keyword_provider_token", severity: "hard" });
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u.test(value)) {
    findings.push({ kind: "secret", reason: "bearer_token", severity: "hard" });
  }
  if (/\b(?:sk|pk|rk|ghp|github_pat)_[A-Za-z0-9._~+/=-]{16,}\b/u.test(value)) {
    findings.push({ kind: "secret", reason: "provider_token", severity: "hard" });
  }
  if (/\b(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{6,}/iu.test(value)) {
    findings.push({ kind: "credential", reason: "password_assignment", severity: "hard" });
  }
  if (/\b(?:postgres|mysql|redis|mongodb):\/\/[^:\s]+:[^@\s]+@/iu.test(value)) {
    findings.push({ kind: "credential", reason: "credentialed_connection_string", severity: "hard" });
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)) {
    findings.push({ kind: "pii", reason: "email_address", severity: "soft" });
  }
  const phoneLike = value.match(/\b(?:\+?\d[\d -]{8,}\d)\b/u)?.[0] ?? null;
  if (phoneLike && !isSafeIdentifier(phoneLike) && !isSafeIdentifier(value)) {
    findings.push({ kind: "pii", reason: "phone_like_number", severity: "soft" });
  }
  if (/(?:^|\s)(?:\/home\/|\/mnt\/[a-z]\/|[A-Z]:\\Users\\)[^\s]+/u.test(value)) {
    findings.push({ kind: "internal_path", reason: "local_internal_path", severity: "soft" });
  }

  const effectiveFindings = findings.length > 0 ? findings : [{ kind: "safe", reason: "no_sensitive_content", severity: "safe" } satisfies PrivacyFinding];
  return {
    blocked: findings.some((finding) => finding.severity === "hard"),
    findings: effectiveFindings,
    reasons: findings.map((finding) => finding.reason),
  };
}
