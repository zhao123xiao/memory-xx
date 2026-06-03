const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9\-_.~+/]+=*/g,
  /(api[_-]?key["\s:=]+)["']?[A-Za-z0-9\-_.]{16,}["']?/gi,
  /(token["\s:=]+)["']?[A-Za-z0-9\-_.]{16,}["']?/gi,
  /(password["\s:=]+)["']?[^\s"'&,;]{8,}["']?/gi,
  /(secret["\s:=]+)["']?[A-Za-z0-9\-_.]{16,}["']?/gi,
];

export function scrubSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "$1****");
  }
  return result;
}
