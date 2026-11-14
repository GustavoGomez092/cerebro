import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Binding, IngestEvent, IngestSession } from "@cerebro/shared";
import { cerebroHome } from "./paths";

export interface Cursor {
  transcriptPath: string;
  source: string;
  sessionId: string;
  offset: number;
  line: number;
  /** Adapter-private data. */
  state: unknown;
  bindingId: string | null;
  cwd: string;
  repo: string;
  subpath: string;
  done: boolean;
}
export type CursorInput = Omit<Cursor, "transcriptPath" | "done">;

export type BlockedReason = "token_revoked" | "unauthorized" | "instance_mismatch";

const SCHEMA = `
create table if not exists cursors (
  transcript_path text primary key, source text not null, session_id text not null,
  offset integer not null default 0, line integer not null default 0, state text,
  binding_id text, cwd text not null, repo text not null, subpath text not null default '',
  done integer not null default 0
);
create table if not exists sessions (id text primary key, json text not null, sent integer not null default 0);
create table if not exists events (
  session_id text not null, key text not null, seq integer not null, json text not null, bytes integer not null,
  primary key (session_id, key)
);
create table if not exists quarantine (session_id text, key text, json text not null, code text not null, at text not null);
create table if not exists bindings (
  repo text not null, subpath text not null, json text, at text not null, primary key (repo, subpath)
);
create table if not exists state (key text primary key, value text);
create table if not exists pending_ends (session_id text primary key, ended_at text not null);
create table if not exists locks (name text primary key, owner_pid integer not null, until integer not null);
`;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function retryBusy(fn: () => void, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { fn(); return; } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") || Date.now() > deadline) throw e;
      Bun.sleepSync(10 + Math.random() * 20);
    }
  }
}

/** Local SQLite store shared by hooks, uploader, importer and MCP server (many short-lived processes). */
export class Store {
  private db: Database;

  constructor(path: string = join(cerebroHome(), "cerebro.db")) {
    this.db = new Database(path, { create: true });
    this.db.run("pragma busy_timeout = 5000");
    // Switching a fresh db to WAL ignores the busy handler when another process is doing the same, so retry.
    retryBusy(() => this.db.run("pragma journal_mode = WAL"));
    this.db.run("pragma synchronous = normal");
    retryBusy(() => this.db.run(SCHEMA));
  }

  close(): void { this.db.close(); }

  // cursors
  getCursor(path: string): Cursor | undefined {
    const r = this.db.query("select * from cursors where transcript_path = ?").get(path) as Row | null;
    return r ? toCursor(r) : undefined;
  }

  setCursor(path: string, c: CursorInput): void {
    this.db.query(
      `insert into cursors (transcript_path, source, session_id, offset, line, state, binding_id, cwd, repo, subpath)
       values (?,?,?,?,?,?,?,?,?,?)
       on conflict(transcript_path) do update set source=excluded.source, session_id=excluded.session_id,
         offset=excluded.offset, line=excluded.line, state=excluded.state, binding_id=excluded.binding_id,
         cwd=excluded.cwd, repo=excluded.repo, subpath=excluded.subpath, done=0`,
    ).run(path, c.source, c.sessionId, c.offset, c.line, JSON.stringify(c.state ?? null), c.bindingId, c.cwd, c.repo, c.subpath);
  }

  openCursors(): Cursor[] {
    return (this.db.query("select * from cursors where done = 0 order by rowid").all() as Row[]).map(toCursor);
  }

  deleteCursor(path: string): void { this.db.query("delete from cursors where transcript_path = ?").run(path); }

  /** Working directories of every transcript ever captured for a binding. */
  boundFolders(): string[] {
    return (this.db.query("select distinct cwd from cursors where binding_id is not null").all() as { cwd: string }[]).map((r) => r.cwd);
  }

  markDone(path: string): void { this.db.query("update cursors set done = 1 where transcript_path = ?").run(path); }

  // sessions
  upsertSession(s: IngestSession): void {
    const json = JSON.stringify(s);
    this.db.query(
      `insert into sessions (id, json, sent) values (?, ?, 0)
       on conflict(id) do update set json = excluded.json, sent = 0 where sessions.json is not excluded.json`,
    ).run(s.id, json);
  }

  unsentSessions(limit: number): IngestSession[] {
    return (this.db.query("select json from sessions where sent = 0 order by rowid limit ?").all(limit) as { json: string }[])
      .map((r) => JSON.parse(r.json));
  }

  /** Marks exactly the versions that were read/sent; a session re-upserted since stays unsent. */
  markSessionsSent(sessions: IngestSession[]): void {
    const q = this.db.query("update sessions set sent = 1 where id = ? and json = ?");
    this.db.transaction(() => { for (const s of sessions) q.run(s.id, JSON.stringify(s)); })();
  }

  // events
  enqueueEvents(events: IngestEvent[]): void {
    const q = this.db.query("insert or ignore into events (session_id, key, seq, json, bytes) values (?,?,?,?,?)");
    this.db.transaction(() => {
      for (const e of events) {
        const json = JSON.stringify(e);
        q.run(e.sessionId, e.key, e.seq, json, Buffer.byteLength(json));
      }
    }).immediate();
  }

  /** Oldest events first, up to `maxEvents` and `maxBytes` (always at least one if any are pending). */
  nextEvents(maxEvents: number, maxBytes: number): IngestEvent[] {
    const rows = this.db.query("select json, bytes from events order by rowid limit ?").all(maxEvents) as { json: string; bytes: number }[];
    const out: IngestEvent[] = [];
    let total = 0;
    for (const r of rows) {
      if (out.length > 0 && total + r.bytes > maxBytes) break;
      total += r.bytes;
      out.push(JSON.parse(r.json));
    }
    return out;
  }

  ackEvents(pairs: { sessionId: string; key: string }[]): void {
    const q = this.db.query("delete from events where session_id = ? and key = ?");
    this.db.transaction(() => { for (const p of pairs) q.run(p.sessionId, p.key); }).immediate();
  }

  pendingCount(): number {
    return (this.db.query("select count(*) as n from events").get() as { n: number }).n;
  }

  // quarantine
  quarantineEvents(items: { event: IngestEvent; code: string }[]): void {
    const ins = this.db.query("insert into quarantine (session_id, key, json, code, at) values (?,?,?,?,?)");
    const del = this.db.query("delete from events where session_id = ? and key = ?");
    const at = new Date().toISOString();
    this.db.transaction(() => {
      for (const { event, code } of items) {
        ins.run(event.sessionId, event.key, JSON.stringify(event), code, at);
        del.run(event.sessionId, event.key);
      }
    }).immediate();
  }

  quarantineCount(): number {
    return (this.db.query("select count(*) as n from quarantine").get() as { n: number }).n;
  }

  // binding cache (null binding = known unbound)
  cacheBinding(repo: string, subpath: string, b: Binding | null): void {
    this.db.query(
      `insert into bindings (repo, subpath, json, at) values (?,?,?,?)
       on conflict(repo, subpath) do update set json = excluded.json, at = excluded.at`,
    ).run(repo, subpath, b ? JSON.stringify(b) : null, new Date().toISOString());
  }

  cachedBinding(repo: string, subpath: string): { binding: Binding | null; at: string } | undefined {
    const r = this.db.query("select json, at from bindings where repo = ? and subpath = ?").get(repo, subpath) as { json: string | null; at: string } | null;
    return r ? { binding: r.json ? JSON.parse(r.json) : null, at: r.at } : undefined;
  }

  // session ends not yet delivered to the server
  /** Records that a session ended; a later time replaces an earlier one. */
  addPendingEnd(sessionId: string, endedAt: string): void {
    this.db.query(
      `insert into pending_ends (session_id, ended_at) values (?, ?)
       on conflict(session_id) do update set ended_at = excluded.ended_at where excluded.ended_at > pending_ends.ended_at`,
    ).run(sessionId, endedAt);
  }

  pendingEnds(): { sessionId: string; endedAt: string }[] {
    return (this.db.query("select session_id, ended_at from pending_ends order by rowid").all() as { session_id: string; ended_at: string }[])
      .map((r) => ({ sessionId: r.session_id, endedAt: r.ended_at }));
  }

  /** Removes the end only if it still has the delivered time, so a newer end is kept. */
  removePendingEnd(sessionId: string, endedAt: string): void {
    this.db.query("delete from pending_ends where session_id = ? and ended_at = ?").run(sessionId, endedAt);
  }

  // key/value state
  get(key: string): string | undefined {
    const r = this.db.query("select value from state where key = ?").get(key) as { value: string | null } | null;
    return r?.value ?? undefined;
  }

  /** `null` clears the key. */
  set(key: string, value: string | null): void {
    if (value === null) { this.db.query("delete from state where key = ?").run(key); return; }
    this.db.query("insert into state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  // locks
  /** Takes `name` unless a live, unexpired holder has it. */
  tryLock(name: string, ttlMs: number): boolean {
    const now = Date.now();
    return this.db.transaction(() => {
      const cur = this.db.query("select owner_pid, until from locks where name = ?").get(name) as { owner_pid: number; until: number } | null;
      if (cur && cur.until > now && pidAlive(cur.owner_pid)) return false;
      this.db.query(
        "insert into locks (name, owner_pid, until) values (?,?,?) on conflict(name) do update set owner_pid = excluded.owner_pid, until = excluded.until",
      ).run(name, process.pid, now + ttlMs);
      return true;
    }).immediate();
  }

  unlock(name: string): void {
    this.db.query("delete from locks where name = ? and owner_pid = ?").run(name, process.pid);
  }
}

type Row = Record<string, any>;
function toCursor(r: Row): Cursor {
  return {
    transcriptPath: r.transcript_path, source: r.source, sessionId: r.session_id, offset: r.offset, line: r.line,
    state: r.state == null ? null : JSON.parse(r.state), bindingId: r.binding_id, cwd: r.cwd, repo: r.repo,
    subpath: r.subpath, done: r.done === 1,
  };
}
