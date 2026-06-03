const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const configuredLevel: LogLevel =
  (Object.keys(LOG_LEVELS) as LogLevel[]).find(
    (l) => l === (process.env.MEMORY_V2_LOG_LEVEL ?? "").toLowerCase().trim()
  ) ?? "info";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  withTrace(traceId: string): Logger;
}

export function createLogger(service: string, boundFields?: Record<string, unknown>): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LOG_LEVELS[level] > LOG_LEVELS[configuredLevel]) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: level.toUpperCase(),
      service,
      message,
    };
    if (boundFields) Object.assign(entry, boundFields);
    if (fields) Object.assign(entry, fields);
    const line = JSON.stringify(entry) + "\n";
    if ((process.env.MEMORY_V2_LOG_TARGET ?? "").toLowerCase().trim() === "stderr" || level === "error" || level === "warn") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    debug: (msg, fields) => emit("debug", msg, fields),
    withTrace: (traceId) => createLogger(service, { ...boundFields, traceId }),
  };
}
