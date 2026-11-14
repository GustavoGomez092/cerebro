export interface Client { id: string; name: string }
export interface Project { id: string; clientId: string; name: string }
export interface Binding {
  id: string;
  repo: string;
  subpath: string;
  status: "active" | "declined";
  clientId: string | null;
  projectId: string | null;
}

export type EventKind = "user" | "assistant" | "tool_call" | "tool_result";

export interface IngestEvent {
  /** Client-chosen idempotency key, unique across all events. */
  key: string;
  sessionId: string;
  seq: number;
  ts: string;
  kind: EventKind;
  text: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface IngestSession {
  id: string;
  bindingId: string;
  cwd: string;
  startedAt: string;
  imported?: boolean;
}

export interface IngestBatch { sessions: IngestSession[]; events: IngestEvent[] }
export interface IngestResult { sessions: number; inserted: number; duplicates: number }
