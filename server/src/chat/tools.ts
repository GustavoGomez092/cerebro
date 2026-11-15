// The chat agent's only way into Cerebro: six read-only tools over stored (already redacted) data, each capped.
import type { SQL } from "bun";
import { z } from "zod";
import type { Embedder } from "../embed/embedder";
import type { EmbedGate } from "../worker";
import type { Metrics } from "../metrics";
import { clientsOverview, globalSearch, sessionSummaries } from "../dashboard";
import { getEvents } from "../read";
import { scopeKey } from "../summarise/state";

export interface ToolContext { sql: SQL; embedder: Embedder; gate?: EmbedGate; metrics: Metrics; machine: string }
export interface ToolResult { text: string; isError?: boolean }

/** Longest tool answer handed to the model; anything past it is cut with a note. */
const MAX_RESULT_CHARS = 60_000;
const EVENT_TEXT_CHARS = 2000;

class ToolError extends Error {}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const plain = (snippet: string) => snippet.replace(/<\/?b>/g, "");
const dateArg = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), { message: "since must be a date such as 2026-11-01" });

/** A client by name, ignoring case. */
async function clientByName(sql: SQL, name: string): Promise<{ id: string; name: string }> {
  const rows = await sql`select id, name from clients where lower(name) = lower(${name.trim()})`;
  if (!rows.length) throw new ToolError(`no client named "${name}"; call list_clients_projects for the names`);
  return rows[0];
}

/** A project by name (ignoring case), within `clientId` when given; an ambiguous name lists its clients. */
async function projectByName(sql: SQL, name: string, clientId: string | null) {
  const rows = await sql`
    select p.id, p.name, c.name as client from projects p join clients c on c.id = p.client_id
    where lower(p.name) = lower(${name.trim()}) and (${clientId}::uuid is null or p.client_id = ${clientId}::uuid)`;
  if (!rows.length) throw new ToolError(`no project named "${name}"${clientId ? " for that client" : ""}; call list_clients_projects for the names`);
  if (rows.length > 1)
    throw new ToolError(`"${name}" is a project of several clients (${rows.map((r: any) => r.client).join(", ")}); pass client too`);
  return rows[0] as { id: string; name: string; client: string };
}

/** Client and project ids from optional names. */
async function narrow(sql: SQL, a: { client?: string; project?: string }) {
  const client = a.client ? await clientByName(sql, a.client) : null;
  const project = a.project ? await projectByName(sql, a.project, client?.id ?? null) : null;
  return { clientId: client?.id, projectId: project?.id };
}

interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  args: S;
  /** Short text for the chat's step list ("searching 'cadco checkout'"). */
  label: (a: z.infer<S>) => string;
  run: (ctx: ToolContext, a: z.infer<S>) => Promise<unknown>;
}
const tool = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

const DEFS = [
  tool({
    name: "global_search",
    description: "Hybrid (full-text + semantic) search over every client's recorded Claude Code conversations and their summaries. " +
      "Optionally narrow to one client and/or project by name. Returns hits with client, project, session id, machine, folder, date and a snippet.",
    args: z.strictObject({
      query: z.string().min(1).max(500),
      client: z.string().min(1).max(200).optional(),
      project: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    label: (a) => `searching "${cut(a.query, 60)}"${a.client ? ` in ${a.client}` : ""}${a.project ? ` / ${a.project}` : ""}`,
    run: async (ctx, a) => {
      const ids = await narrow(ctx.sql, a);
      const r = await globalSearch(ctx, ctx.machine, { query: a.query, limit: a.limit ?? 10, ...ids });
      return {
        hits: r.hits.map((h) => ({
          kind: h.kind, client: h.clientName, project: h.projectName, sessionId: h.sessionId, machine: h.machine, cwd: h.cwd,
          date: h.tsFrom, until: h.tsTo, seq: h.firstSeq === null ? null : [h.firstSeq, h.lastSeq], snippet: plain(h.snippet),
        })),
        ...(r.degraded ? { note: `partial results (${r.degradedReasons.join(", ")})` } : {}),
      };
    },
  }),
  tool({
    name: "list_clients_projects",
    description: "Every client with its projects, session counts per machine and the last activity date.",
    args: z.strictObject({}),
    label: () => "listing clients and projects",
    run: async (ctx) => {
      const { clients } = await clientsOverview(ctx.sql);
      return {
        clients: clients.map((c) => ({
          name: c.name, sessions: c.sessions, lastActivityAt: c.lastActivityAt,
          projects: c.projects.map((p) => ({ name: p.name, sessions: p.sessions, lastActivityAt: p.lastActivityAt, machines: p.machines })),
        })),
      };
    },
  }),
  tool({
    name: "get_session_summary",
    description: "One session's details (client, project, machine, folder, dates) and its summaries: overview, decisions, changes, facts, open threads.",
    args: z.strictObject({ session_id: z.string().min(1).max(200) }),
    label: (a) => `reading the summary of session ${cut(a.session_id, 40)}`,
    run: async (ctx, a) => {
      const s = await sessionSummaries(ctx.sql, a.session_id);
      if (!s) throw new ToolError(`no session ${a.session_id}`);
      return s;
    },
  }),
  tool({
    name: "get_project_state",
    description: "The running state document of a project (or of a client, when project is omitted): overview, current status, decisions, open threads, facts.",
    args: z.strictObject({ client: z.string().min(1).max(200), project: z.string().min(1).max(200).optional() }),
    label: (a) => `reading the state of ${a.client}${a.project ? ` / ${a.project}` : ""}`,
    run: async (ctx, a) => {
      const client = await clientByName(ctx.sql, a.client);
      const project = a.project ? await projectByName(ctx.sql, a.project, client.id) : null;
      const [row] = await ctx.sql`
        select text, version, updated_at from project_states where scope = ${scopeKey(client.id, project?.id ?? null)} and text <> ''`;
      const base = { client: client.name, project: project?.name ?? null };
      if (row) return { ...base, text: row.text, version: row.version, updatedAt: row.updated_at.toISOString() };
      // No state yet: say how far the summariser is for this scope, so the model reads sessions instead of
      // concluding the project has no history.
      const [n] = await ctx.sql`
        select count(*)::int as sessions,
               count(*) filter (where exists (select 1 from summaries sm where sm.session_id = s.id))::int as summarised
        from sessions s join bindings b on b.id = s.binding_id
        where b.status = 'active' and b.client_id = ${client.id}
          and (${project?.id ?? null}::uuid is null or b.project_id = ${project?.id ?? null}::uuid)`;
      return {
        ...base, state: null, sessions: n.sessions, summarisedSessions: n.summarised,
        note: `The state document is not built yet (${n.summarised} of ${n.sessions} sessions summarised so far; the ` +
          "summariser works through imported history gradually). The history exists: use recent_sessions, " +
          "get_session_summary and get_session_events to answer from the sessions themselves.",
      };
    },
  }),
  tool({
    name: "recent_sessions",
    description: "Recent sessions, newest activity first, optionally for one client and/or project and since a date. " +
      "Each has its id, client, project, machine, folder, start, last activity and the latest summary title.",
    args: z.strictObject({
      client: z.string().min(1).max(200).optional(),
      project: z.string().min(1).max(200).optional(),
      since: dateArg.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    label: (a) => `listing recent sessions${a.client ? ` of ${a.client}` : ""}${a.project ? ` / ${a.project}` : ""}${a.since ? ` since ${a.since}` : ""}`,
    run: async (ctx, a) => {
      const { clientId, projectId } = await narrow(ctx.sql, a);
      const since = a.since ? new Date(a.since).toISOString() : null;
      const rows = await ctx.sql`
        select s.id, cl.name as client, p.name as project, m.name as machine, s.cwd, s.started_at, s.last_event_at,
               (select title from summaries sm where sm.session_id = s.id order by sm.last_seq desc limit 1) as summary_title
        from sessions s join bindings b on b.id = s.binding_id join machines m on m.id = s.machine_id
        left join clients cl on cl.id = b.client_id left join projects p on p.id = b.project_id
        where b.status = 'active'
          and (${clientId ?? null}::uuid is null or b.client_id = ${clientId ?? null}::uuid)
          and (${projectId ?? null}::uuid is null or b.project_id = ${projectId ?? null}::uuid)
          and (${since}::timestamptz is null or coalesce(s.last_event_at, s.started_at) >= ${since}::timestamptz)
        order by coalesce(s.last_event_at, s.started_at) desc, s.id desc
        limit ${a.limit ?? 20}`;
      return {
        sessions: rows.map((r: any) => ({
          id: r.id, client: r.client, project: r.project, machine: r.machine, cwd: r.cwd,
          startedAt: r.started_at.toISOString(), lastActivityAt: (r.last_event_at ?? r.started_at).toISOString(), summaryTitle: r.summary_title,
        })),
      };
    },
  }),
  tool({
    name: "get_session_events",
    description: "Raw messages of one session in order (user, assistant, tool calls and results), after a sequence number. " +
      `Each text is cut at ${EVENT_TEXT_CHARS} characters; page with after_seq = the returned nextSeq.`,
    args: z.strictObject({
      session_id: z.string().min(1).max(200),
      after_seq: z.number().int().min(-1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    label: (a) => `reading messages of session ${cut(a.session_id, 40)}`,
    run: async (ctx, a) => {
      const page = await getEvents(ctx.sql, a.session_id, { kind: "open" }, { afterSeq: a.after_seq, limit: a.limit ?? 50 });
      if (!page) throw new ToolError(`no session ${a.session_id}`);
      return {
        events: page.events.map((e) => ({
          seq: e.seq, ts: e.ts, kind: e.kind, toolName: e.toolName,
          text: cut(e.text, EVENT_TEXT_CHARS), ...(e.toolInput ? { toolInput: cut(JSON.stringify(e.toolInput), 500) } : {}),
        })),
        nextSeq: page.nextSeq,
      };
    },
  }),
];

const toSchema = (s: z.ZodTypeAny) => {
  const { $schema: _, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest as { type: string; properties?: object; required?: string[] };
};

/** The tools as MCP lists them. */
export const CHAT_TOOLS = DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: toSchema(d.args) }));

/** The step label for a tool call, or the tool's name when its arguments don't parse. */
export function toolLabel(name: string, args: unknown): string {
  const d = DEFS.find((x) => x.name === name);
  const a = d?.args.safeParse(args ?? {});
  return d && a?.success ? (d.label as (x: unknown) => string)(a.data) : name;
}

/** Runs one tool; argument and lookup problems come back as an error result the model can read and correct. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  const d = DEFS.find((x) => x.name === name);
  if (!d) return { text: `unknown tool ${name}`, isError: true };
  const a = d.args.safeParse(args ?? {});
  if (!a.success) return { text: `invalid arguments: ${a.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, isError: true };
  try {
    const out = JSON.stringify(await (d.run as (c: ToolContext, x: unknown) => Promise<unknown>)(ctx, a.data));
    return { text: out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}… [cut at ${MAX_RESULT_CHARS} characters]` : out };
  } catch (e) {
    if (e instanceof ToolError) return { text: e.message, isError: true };
    throw e;
  }
}
