export interface AgentSessionState {
  readonly agent_id: string;
  last_recall_at: string | null;
  last_write_at: string | null;
  memory_count: number;
  created_at: string;
}
const sessions = new Map<string, AgentSessionState>();
export function getOrCreateSession(agentId: string): AgentSessionState {
  const existing = sessions.get(agentId);
  if (existing) return existing;
  const session: AgentSessionState = {
    agent_id: agentId, last_recall_at: null, last_write_at: null,
    memory_count: 0, created_at: new Date().toISOString(),
  };
  sessions.set(agentId, session);
  return session;
}
export function recordRecall(agentId: string): void {
  const session = getOrCreateSession(agentId);
  session.last_recall_at = new Date().toISOString();
}
export function recordWrite(agentId: string): void {
  const session = getOrCreateSession(agentId);
  session.last_write_at = new Date().toISOString();
  session.memory_count++;
}
export function getSession(agentId: string): AgentSessionState | null {
  return sessions.get(agentId) ?? null;
}
