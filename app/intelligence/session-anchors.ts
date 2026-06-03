import type { MemoryType } from "./types";

export interface SessionAnchor {
  readonly anchor_id: string;
  readonly session_id: string;
  readonly turn_id?: string;
  readonly run_id?: string;
  readonly memory_type: MemoryType;
  readonly topic: string;
  readonly created_at: string;
  readonly priority: number;
}

export interface SessionContextResult {
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly run_id?: string;
  readonly anchor_hit: boolean;
  readonly contextual_followup: boolean;
  readonly anchor_id?: string;
  readonly anchor_memory_type?: MemoryType;
  readonly anchor_topic?: string;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ANCHORS = 10;

const PRIORITY: Record<MemoryType, number> = {
  preference: 1,
  fact: 2,
  procedure: 3,
  constraint: 4,
  decision: 4,
};

function nowMs(): number {
  return Date.now();
}

function isExpired(anchor: SessionAnchor, now = nowMs()): boolean {
  return now - Date.parse(anchor.created_at) > SESSION_TTL_MS;
}

export class SessionAnchorStore {
  private static readonly anchors = new Map<string, SessionAnchor[]>();

  getContext(input: {
    readonly session_id?: string;
    readonly turn_id?: string;
    readonly run_id?: string;
  }): SessionContextResult {
    if (!input.session_id) {
      return {
        session_id: input.session_id,
        turn_id: input.turn_id,
        run_id: input.run_id,
        anchor_hit: false,
        contextual_followup: false,
      };
    }
    const anchors = this.getActiveAnchors(input.session_id);
    const anchor = anchors.at(-1);
    return {
      session_id: input.session_id,
      turn_id: input.turn_id,
      run_id: input.run_id,
      anchor_hit: Boolean(anchor),
      contextual_followup: Boolean(anchor),
      anchor_id: anchor?.anchor_id,
      anchor_memory_type: anchor?.memory_type,
      anchor_topic: anchor?.topic,
    };
  }

  rememberAnchor(input: {
    readonly session_id?: string;
    readonly turn_id?: string;
    readonly run_id?: string;
    readonly memory_type: MemoryType;
    readonly topic: string;
    readonly anchor_id: string;
  }): SessionContextResult {
    const context = this.getContext(input);
    if (!input.session_id) return context;
    const anchors = this.getActiveAnchors(input.session_id);
    anchors.push({
      anchor_id: input.anchor_id,
      session_id: input.session_id,
      turn_id: input.turn_id,
      run_id: input.run_id,
      memory_type: input.memory_type,
      topic: input.topic,
      created_at: new Date().toISOString(),
      priority: PRIORITY[input.memory_type],
    });
    SessionAnchorStore.anchors.set(input.session_id, evictAnchors(anchors));
    return this.getContext(input);
  }

  private getActiveAnchors(sessionId: string): SessionAnchor[] {
    const active = (SessionAnchorStore.anchors.get(sessionId) ?? []).filter((anchor) => !isExpired(anchor));
    SessionAnchorStore.anchors.set(sessionId, active);
    return active;
  }

  static clear(): void {
    SessionAnchorStore.anchors.clear();
  }
}

function evictAnchors(anchors: SessionAnchor[]): SessionAnchor[] {
  if (anchors.length <= MAX_ANCHORS) return anchors;
  const sorted = [...anchors].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return Date.parse(left.created_at) - Date.parse(right.created_at);
  });
  const remove = new Set(sorted.slice(0, anchors.length - MAX_ANCHORS).map((anchor) => anchor.anchor_id));
  return anchors.filter((anchor) => !remove.has(anchor.anchor_id));
}
