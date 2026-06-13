export interface DecayInput {
  readonly importance: number;
  readonly usageCount: number;
  readonly supportCount: number;
  readonly sourceAuthority: number;
  readonly daysSinceAccess: number;
  readonly conflictCount: number;
  readonly daysSinceCreated: number;
}

export const ARCHIVE_THRESHOLD = 0.30;
export const HIDE_THRESHOLD = 0.10;
export const RESURRECTION_BOOST = 0.20;
export const MAX_USAGE = 100;
export const MAX_SUPPORT = 10;

function readThreshold(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export function archiveThreshold(): number {
  return readThreshold("MEMORY_XX_DECAY_ARCHIVE_THRESHOLD", ARCHIVE_THRESHOLD);
}

export function hideThreshold(): number {
  return readThreshold("MEMORY_XX_DECAY_HIDE_THRESHOLD", HIDE_THRESHOLD);
}

function recencyDecay(daysSinceAccess: number): number {
  if (daysSinceAccess <= 0) return 0;
  return 1 - Math.exp(-0.05 * daysSinceAccess);
}

function stalePenalty(daysSinceCreated: number): number {
  if (daysSinceCreated <= 30) return 0;
  return Math.min(1, (daysSinceCreated - 30) / 365);
}

export function calculateMemoryStrength(input: DecayInput): number {
  const raw =
    0.5 // base
    + input.importance * 0.25
    + (input.usageCount / MAX_USAGE) * 0.15
    + (input.supportCount / MAX_SUPPORT) * 0.10
    + input.sourceAuthority * 0.10
    - recencyDecay(input.daysSinceAccess) * 0.15
    - input.conflictCount * 0.10
    - stalePenalty(input.daysSinceCreated) * 0.15;

  return Math.max(0, Math.min(1, raw));
}

export function shouldArchive(strength: number): boolean {
  return strength < archiveThreshold();
}

export function shouldHide(strength: number): boolean {
  return strength < hideThreshold();
}

export function wouldResurrect(
  currentStrength: number,
  currentDaysSinceAccess: number
): boolean {
  const boosted = currentStrength + RESURRECTION_BOOST;
  return boosted >= archiveThreshold() && currentDaysSinceAccess < 7;
}
