import { randomUUID } from "node:crypto";

export function generateRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function reportTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
