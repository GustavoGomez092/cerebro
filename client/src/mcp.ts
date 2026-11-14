import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Client, EventView, Project } from "@cerebro/shared";
import { z } from "zod";
import { ApiClient, ApiError } from "./api";
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
    "Search past conversations recorded for this folder's project (full text and semantic).",
    { query: z.string(), from: z.string().optional(), to: z.string().optional(), limit: z.number().int().positive().optional() },
    async (a) => {
      const r = await api.search({ query: a.query, from: a.from, to: a.to, limit: a.limit, ...scope });
      const lines = r.hits.map((h) =>
        `${h.sessionId} seq ${h.firstSeq}-${h.lastSeq} | ${range(h.tsFrom, h.tsTo)} | ${name(h.clientName, h.projectName)} | ${h.snippet.replace(/\s+/g, " ")} | matched: ${h.matched.join("+")}`);
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
      // Capture looks up this folder's own subpath; the server resolves it to the wider binding.
      if (scope.subpath !== subpath) store.cacheBinding(scope.repo, scope.subpath, binding);
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

