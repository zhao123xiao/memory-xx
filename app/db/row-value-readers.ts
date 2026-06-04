export function readPgBoolean(value: unknown, fieldName = "boolean"): boolean {
  if (process.env.MEMORY_XX_LEGACY_BOOLEAN_COERCION === "true") {
    return Boolean(value);
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "t" || normalized === "true" || normalized === "1") return true;
    if (normalized === "f" || normalized === "false" || normalized === "0") return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  throw new TypeError(`Expected PostgreSQL boolean value for ${fieldName}.`);
}

export function readNullablePgBoolean(value: unknown, fieldName = "boolean"): boolean | null {
  if (value === null || value === undefined) return null;
  return readPgBoolean(value, fieldName);
}
