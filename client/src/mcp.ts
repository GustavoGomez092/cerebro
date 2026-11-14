import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HISTORY_LIMITS, redactSecrets, type Client, type EventView, type Project, type SearchHit, type SummaryView } from "@cerebro/shared";
import { z } from "zod";
import { ApiClient, ApiError } from "./api";
import { plainLine, plainText } from "./brief";
import { loadClientConfig } from "./config";
import { folderIdentity } from "./identity";
import { verifyServer, type Verification } from "./instance";
import { logError } from "./log";
import { spawnDetached } from "./spawn";
import { Store } from "./store";

export interface McpDeps {
  api: ApiClient;
  store: Store;
  cwd: string;
  machine: string;
  /** Starts a detached `cerebro <args>`; defaults to spawnDetached. Injected by tests. */
  spawn?: (args: string[]) => void;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const HEALTH_TIMEOUT_MS = 3000;

/** Why a tool sent nothing, for each failed instance check. */
function unverifiedText(v: Exclude<Verification, "ok">, blocked: string | undefined): string {
  if (v === "mismatch" || blocked === "instance_mismatch") {
    return "Nothing was sent: the server at the configured URL is not the Cerebro instance this Mac was set up with. " +
      "Check the server URL; if the server was reinstalled, run `~/.cerebro/bin/cerebro reset-instance`.";
  }
  if (v === "blocked") {
    return `Nothing was sent: Cerebro is blocked (${blocked}) because the server refused this Mac's token. ` +
      "Fix the token in the plugin's settings, then run `~/.cerebro/bin/cerebro status --retry`.";
  }
  return "The Cerebro server is unreachable right now (or did not identify itself); nothing was sent. Try again later.";
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "rebind_required") {
      return "This folder is already bound to a different client/project (rebind_required). Ask the user to confirm moving it, then call again with rebind: true.";
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

const range = (a: string, b: string) => (a === b ? a : `${a} - ${b}`);
const name = (c: string | null, p: string | null) => [c, p].filter(Boolean).join("/") || "unassigned";

function formatEvent(e: EventView): string {
  return `[${e.seq}] ${e.kind}${e.toolName ? ` (${e.toolName})` : ""} ${e.text}${e.truncated ? " [truncated]" : ""}`;
}

/** Where a hit or summary came from: a session range, or (no session) a folder's initial history. */
function origin(x: Pick<SearchHit, "sessionId" | "firstSeq" | "lastSeq">): string {
  if (!x.sessionId) return "initial project history";
  return x.firstSeq != null && x.lastSeq != null ? `${x.sessionId} seq ${x.firstSeq}-${x.lastSeq}` : x.sessionId;
}

function formatSummary(s: SummaryView): string {
  const lines = [`[${s.kind}] ${plainLine(s.title, 200)} | ${range(s.tsFrom, s.tsTo)} | ${name(s.clientName, s.projectName)} | ${origin(s)}`];
  const overview = plainLine(s.overview, 1200);
  if (overview) lines.push(`  ${overview}`);
  const facts = (Array.isArray(s.facts) ? s.facts : []).map((f) => plainLine(f, 300)).filter(Boolean);
  if (facts.length) lines.push(`  facts: ${facts.join("; ")}`);
  return lines.join("\n");
}

/** A date (2026-01-31, read as the whole UTC day) or an ISO time, as the ISO time the server takes. */
function isoTime(v: string, label: string, endOfDay: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = `${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
    if (!Number.isNaN(Date.parse(t))) return t;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) {
    return new Date(v).toISOString();
  }
  throw new Error(`${label} must be a date like 2026-01-31 or an ISO time; nothing was sent.`);
}

/** Checks one field of an initial history against the server's limit before anything is sent. */
function limited(v: string, label: string, max: number): string {
  if (!v) throw new Error(`${label} is empty; nothing was sent.`);
  if (v.length > max) throw new Error(`${label} is ${v.length} characters; the limit is ${max}. Shorten it and call again; nothing was sent.`);
  return v;
}

/** The recall and setup tools for the folder `cwd`. Recall always sends the folder's repo/subpath, never `scope: "open"`. */
export function createMcpServer(deps: McpDeps): McpServer {
  const { api, store, machine } = deps;
  const spawn = deps.spawn ?? spawnDetached;
  const ident = folderIdentity(deps.cwd, machine);
  const scope = { repo: ident.repo, subpath: ident.subpath };
  const server = new McpServer({ name: "cerebro", version: "0.1.0" });

  /** Runs a tool body, turning any failure into an MCP tool error. */
  const tool = <S extends z.ZodRawShape>(
    id: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<string>,
  ) => {
    const handler = async (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
      try {
        // Every tool talks to the server with the token, so each one first checks it is the pinned instance.
        const v = await verifyServer(store, api, { timeoutMs: HEALTH_TIMEOUT_MS });
        if (v !== "ok") return fail(unverifiedText(v, store.get("blocked")));
        return ok(await fn(args));
      } catch (e) {
        return fail(errorText(e));
      }
    };
    server.registerTool(id, { description, inputSchema: shape }, handler as never);
  };

  tool("cerebro_search",
    "Search past conversations and their summaries recorded for this folder's project (full text and semantic). Summary hits come first, marked [summary].",
    { query: z.string(), from: z.string().optional(), to: z.string().optional(), limit: z.number().int().positive().optional() },
    async (a) => {
      const r = await api.search({ query: a.query, from: a.from, to: a.to, limit: a.limit, ...scope });
      const hits = [...r.hits.filter((h) => h.kind === "summary"), ...r.hits.filter((h) => h.kind !== "summary")];
      const lines = hits.map((h) => {
        const where = `${range(h.tsFrom, h.tsTo)} | ${name(h.clientName, h.projectName)}`;
        const matched = `matched: ${h.matched.join("+")}`;
        // A summary's snippet is "title — excerpt", written by the summariser (or the client's own Claude).
        if (h.kind === "summary") return `[summary] ${plainLine(h.snippet, 600)} | ${where} | ${origin(h)} | ${matched}`;
        return `${origin(h)} | ${where} | ${h.snippet.replace(/\s+/g, " ")} | ${matched}`;
      });
      if (!lines.length) lines.push("No matches.");
      if (r.degraded) lines.push(`Note: results are degraded (${r.degradedReasons.join(", ")}); some matches may be missing.`);
      return lines.join("\n");
    });

  tool("cerebro_sessions",
    "List recorded sessions for this folder's project, newest first.",
    { from: z.string().optional(), to: z.string().optional(), limit: z.number().int().positive().optional(), before: z.string().optional() },
    async (a) => {
      const r = await api.sessions({ ...a, ...scope });
      const lines = r.sessions.map((s) =>
        `${s.id} | ${range(s.startedAt, s.lastEventAt ?? s.startedAt)} | ${name(s.clientName, s.projectName)} | ${s.machine} | ${s.cwd}${s.imported ? " | imported" : ""}`);
      if (!lines.length) lines.push("No sessions.");
      if (r.next) lines.push(`next (pass as before): ${r.next}`);
      return lines.join("\n");
    });

  tool("cerebro_read",
    "Read the events of one session, paged. Pass next_seq as after_seq to continue.",
    { session_id: z.string(), after_seq: z.number().int().min(0).optional(), limit: z.number().int().positive().optional(), full: z.boolean().optional() },
    async (a) => {
      const r = await api.events(a.session_id, { afterSeq: a.after_seq, limit: a.limit, full: a.full, ...scope });
      const lines = r.events.map(formatEvent);
      if (!lines.length) lines.push("No events.");
      if (r.nextSeq != null) lines.push(`next_seq: ${r.nextSeq}`);
      return lines.join("\n");
    });

  tool("cerebro_state",
    "Show the running state Cerebro keeps for this folder's project (or client): status, decisions, open threads, facts.",
    {},
    async () => {
      const r = await api.state(scope);
      if (!r.scope) return "This folder has no client or project binding, so Cerebro keeps no project state for it.";
      const of = r.scope.startsWith("client:") ? "this client" : "this project";
      if (!r.state) return `No project state yet for ${of}: Cerebro builds it from summaries of finished sessions.`;
      return `Project state for ${of} (version ${r.state.version}, updated ${r.state.updatedAt}), summarised by Cerebro from past sessions:\n\n` +
        plainText(r.state.text, 8000);
    });

  tool("cerebro_summaries",
    "List dated summaries of this folder's project (session summaries and the initial project history), newest first. Dates like 2026-01-31; pass next as before to page.",
    {
      from: z.string().optional(), to: z.string().optional(), limit: z.number().int().positive().max(100).optional(),
      before: z.string().optional(),
    },
    async (a) => {
      const r = await api.summaries({
        ...scope, limit: a.limit, before: a.before,
        from: a.from ? isoTime(a.from, "from", false) : undefined,
        to: a.to ? isoTime(a.to, "to", true) : undefined,
      });
      const lines = r.summaries.map(formatSummary);
      if (!lines.length) lines.push("No summaries.");
      if (r.next) lines.push(`next (pass as before): ${r.next}`);
      return lines.join("\n");
    });

  tool("cerebro_save_history",
    `Save the initial history of this folder's project, written from its git log and docs, covering from..to (dates like 2026-01-31). ` +
    `title ≤ ${HISTORY_LIMITS.maxTitle} chars, text ≤ ${HISTORY_LIMITS.maxText} chars. Saving the same period again replaces it.`,
    { title: z.string(), text: z.string(), from: z.string(), to: z.string() },
    async (a) => {
      // Secrets never leave this Mac, and the limits are the ones the server applies to what it receives.
      const title = limited(redactSecrets(a.title).trim(), "title", HISTORY_LIMITS.maxTitle);
      const text = limited(redactSecrets(a.text).trim(), "text", HISTORY_LIMITS.maxText);
      const tsFrom = isoTime(a.from, "from", false), tsTo = isoTime(a.to, "to", true);
      if (Date.parse(tsFrom) > Date.parse(tsTo)) throw new Error("from is after to; nothing was sent.");
      let saved: SummaryView;
      try {
        saved = (await api.saveHistory({ ...scope, title, text, tsFrom, tsTo })).summary;
      } catch (e) {
        if (e instanceof ApiError && e.code === "unknown_binding") {
          throw new Error("This folder is not bound to a client/project in Cerebro, so the history was not saved. " +
            "Bind it first with cerebro_bind (after asking the user), then call cerebro_save_history again.");
        }
        if (e instanceof ApiError && e.code === "binding_declined") {
          throw new Error("This folder is declined in Cerebro (the user chose not to record it), so the history was not saved.");
        }
        throw e;
      }
      return `Saved the project history "${title}" (${range(tsFrom.slice(0, 10), tsTo.slice(0, 10))}) for ${name(saved.clientName, saved.projectName)}. ` +
        "It is searchable now and feeds the project state.";
    });

  tool("cerebro_folder",
    "Show this folder's identity, its current binding, and the known clients with their projects.",
    {},
    async () => {
      const { binding } = await api.resolve(scope.repo, scope.subpath);
      store.cacheBinding(scope.repo, scope.subpath, binding);
      const { clients } = await api.listClients();
      const projects = new Map<string, Project[]>();
      for (const c of clients) projects.set(c.id, (await api.listProjects(c.id)).projects);
      const cName = (id: string | null) => clients.find((c) => c.id === id)?.name ?? null;
      const pName = (id: string | null) => [...projects.values()].flat().find((p) => p.id === id)?.name ?? null;
      const out = [
        `folder: ${deps.cwd}`,
        `repo: ${scope.repo}`,
        `subpath: ${scope.subpath || "(repo root)"}`,
        binding
          ? `binding: ${binding.status}${binding.status === "active" ? ` -> ${name(cName(binding.clientId), pName(binding.projectId))}` : ""} (for ${binding.subpath || "repo root"})`
          : "binding: none (this folder is not bound; nothing is captured)",
        "clients:",
        ...clients.map((c: Client) => `- ${c.name}: ${(projects.get(c.id) ?? []).map((p) => p.name).join(", ") || "(no projects)"}`),
      ];
      return out.join("\n");
    });

  tool("cerebro_bind",
    "Record this folder's work under a client/project (created when new) and import its past conversations. Changing an existing binding needs rebind: true, only after the user confirmed.",
    { client: z.string(), project: z.string().optional(), whole_repo: z.boolean().optional(), rebind: z.boolean().optional() },
    async (a) => {
      const subpath = a.whole_repo === false ? scope.subpath : "";
      const { clients } = await api.listClients();
      const client = clients.find((c) => c.name.toLowerCase() === a.client.toLowerCase()) ?? await api.createClient(a.client);
      let project: Project | undefined;
      if (a.project) {
        const existing = (await api.listProjects(client.id)).projects;
        project = existing.find((p) => p.name.toLowerCase() === a.project!.toLowerCase()) ?? await api.createProject(client.id, a.project);
      }
      const { binding } = await api.putBinding({
        repo: scope.repo, subpath, status: "active", clientId: client.id, projectId: project?.id ?? null, rebind: a.rebind,
      });
      store.cacheBinding(scope.repo, subpath, binding);
      // Capture looks up this folder's own subpath, which may have a binding of its own: cache the server's answer.
      if (scope.subpath !== subpath) {
        try {
          store.cacheBinding(scope.repo, scope.subpath, (await api.resolve(scope.repo, scope.subpath)).binding);
        } catch (e) {
          logError("mcp bind resolve", e); // the bind stands; the next SessionStart or sync looks the folder up
        }
      }
      spawn(["import", "--cwd", deps.cwd]);
      let text = `Bound ${subpath || "the repo root"} to ${name(client.name, project?.name ?? null)}. Importing past conversations in the background.`;
      if (a.whole_repo === false && !scope.subpath) text += " This folder is the repo root, so this binds the whole repo.";
      if (subpath) text += await adoptHint(subpath);
      return text;
    });

  /** When a subfolder is bound, sessions already recorded under the repo's wider binding may belong to it. */
  async function adoptHint(subpath: string): Promise<string> {
    try {
      const wide = await api.sessions({ repo: scope.repo, subpath: "", limit: 1 });
      if (!wide.sessions.length) return "";
      return ` Sessions already exist under the repo's wider binding; if some were held in ${subpath}, call cerebro_adopt to move them here.`;
    } catch {
      return "";
    }
  }

  tool("cerebro_decline",
    "Mark this folder as not to be recorded. Changing an existing binding needs rebind: true, only after the user confirmed.",
    { rebind: z.boolean().optional() },
    async (a) => {
      const { binding } = await api.putBinding({
        repo: scope.repo, subpath: scope.subpath, status: "declined", clientId: null, projectId: null, rebind: a.rebind,
      });
      store.cacheBinding(scope.repo, scope.subpath, binding);
      return `This folder will not be recorded.`;
    });

  tool("cerebro_adopt",
    "Move sessions recorded under this repo's wider binding into this folder's binding, when they happened in this folder.",
    {},
    async () => {
      const { binding } = await api.resolve(scope.repo, scope.subpath);
      if (!binding || binding.status !== "active") throw new Error("This folder has no active binding; call cerebro_bind first.");
      const { moved } = await api.adopt(binding.id);
      return `Moved ${moved} session(s) into this folder's binding.`;
    });

  return server;
}

/** Runs the stdio MCP server until the client disconnects. */
export async function startMcpServer(): Promise<void> {
  const config = loadClientConfig();
  if (!config) throw new Error("Cerebro is not configured: set the server URL and token");
  const store = new Store();
  const api = new ApiClient(config, store);
  let machine = store.get("machine");
  if (!machine) {
    try {
      if ((await verifyServer(store, api, { timeoutMs: 5000 })) !== "ok") throw new Error("server not verified; machine name unknown");
      machine = (await api.status({ timeoutMs: 5000 })).machine || undefined;
      if (machine) store.set("machine", machine);
    } catch (e) {
      logError("mcp status", e);
    }
  }
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const server = createMcpServer({ api, store, cwd, machine: machine ?? hostname() });
  const closed = new Promise<void>((resolve) => { server.server.onclose = resolve; });
  // The stdio transport does not notice the client closing our stdin.
  process.stdin.once("end", () => void server.close());
  await server.connect(new StdioServerTransport());
  await closed;
  store.close();
}

