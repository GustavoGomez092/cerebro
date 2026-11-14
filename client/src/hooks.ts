import type { Binding, SessionView } from "@cerebro/shared";
import type { ApiClient } from "./api";
import { buildBrief } from "./brief";
import { captureTranscript, type CaptureResult } from "./capture";
import { folderIdentity, type FolderIdentity } from "./identity";
import { checkInstance } from "./instance";
import { logError } from "./log";
import { claudeCodeSource } from "./sources/claude-code";
import { ensureCliLink } from "./schedule";
import { spawnDetached } from "./spawn";
import type { BlockedReason, Store } from "./store";

export type HookEvent = "SessionStart" | "Stop" | "PreCompact" | "SessionEnd";
export const HOOK_EVENTS: readonly HookEvent[] = ["SessionStart", "Stop", "PreCompact", "SessionEnd"];

/** The fields Claude Code sends on stdin that Cerebro uses. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionStart: startup | resume | clear | compact | fork */
  source?: string;
  /** SessionEnd: clear | resume | logout | prompt_input_exit | other */
  reason?: string;
}

export interface HookDeps {
  store: Store;
  /** null when the plugin has no server URL/token. */
  api: ApiClient | null;
  /** Cached machine name (state `machine`), null until the server has told us. */
  machine: string | null;
  env: Record<string, string | undefined>;
  /** Defaults to spawnDetached; tests record the calls instead. */
  spawn?: (args: string[]) => void;
}

/** One budget for every network call SessionStart makes (health, machine name, resolve, sessions). */
const NETWORK_BUDGET_MS = 1500;
/** Not worth starting a request with less time than this left. */
const MIN_CALL_MS = 50;
/** SessionStart starts a background `cerebro sync` (other agents' history) when the last one is older than this. */
const SYNC_EVERY_MS = 60 * 60_000;

export const UNKNOWN_FOLDER_CONTEXT =
  "Cerebro memory is installed but this folder is not set up. Before starting the user's task, use the cerebro skill to ask whether to use Cerebro here.";
export const NOT_CONFIGURED_CONTEXT =
  "Cerebro memory is installed but not configured, so this session is not being recorded. " +
  "Mention once to the user that they can enable it by entering the Cerebro server URL and token in the plugin's settings (/plugin).";

const PROBLEMS: Record<BlockedReason, string> = {
  token_revoked:
    "uploads are stopped: this Mac's Cerebro token was revoked. Ask the owner for a new token, put it in the plugin's settings, then run `~/.cerebro/bin/cerebro status --retry`.",
  unauthorized:
    "uploads are stopped: the server does not accept this Mac's token. Check the token in the plugin's settings, then run `~/.cerebro/bin/cerebro status --retry`.",
  instance_mismatch:
    "uploads are stopped: the server answering at the configured URL is not the Cerebro instance this Mac was set up with. " +
    "Check the server URL; if the server was reinstalled, run `~/.cerebro/bin/cerebro reset-instance`.",
};

/**
 * Non-interactive runs are never recorded or prompted: Cerebro's own summariser (CEREBRO_HEADLESS=1),
 * and `claude -p` / SDK sessions, which Claude Code marks with CLAUDE_CODE_ENTRYPOINT=sdk-* and
 * CLAUDE_CODE_SESSION_ATTENDED=0 in the hook's environment.
 */
export function isHeadless(env: Record<string, string | undefined>): boolean {
  return env.CEREBRO_HEADLESS === "1" || (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk") || env.CLAUDE_CODE_SESSION_ATTENDED === "0";
}

/** Runs one hook and returns what to print on stdout (JSON or ""). Never throws. */
export async function handleHook(event: HookEvent, input: HookInput, deps: HookDeps): Promise<string> {
  const spawn = (args: string[]) => {
    try { (deps.spawn ?? spawnDetached)(args); } catch (e) { logError(`spawn ${args[0]}`, e); }
  };
  const i: HookInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  try {
    if (isHeadless(deps.env)) return ""; // no capture, no network, no spawns
    switch (event) {
      case "SessionStart":
        try { return await sessionStart(i, deps, spawn); } finally { spawn(["flush"]); }
      case "Stop":
      case "PreCompact":
        try { captureSession(i, deps); } finally { spawn(["flush"]); }
        return "";
      case "SessionEnd": {
        // No network here: Claude Code gives SessionEnd hooks ~1.5 s, so the detached flush ends the session.
        let end = false;
        try {
          const r = captureSession(i, deps);
          // End any session tied to a binding, even if its transcript is gone; the server ignores unknown ones.
          const cursor = i.transcript_path ? deps.store.getCursor(i.transcript_path) : undefined;
          end = r?.status !== "headless" && (r?.status === "recorded" || !!cursor?.bindingId);
          if (i.reason !== "clear" && i.transcript_path) deps.store.markDone(i.transcript_path);
        } finally {
          spawn(end && i.session_id ? ["flush", "--end", i.session_id, new Date().toISOString()] : ["flush"]);
        }
        return "";
      }
      default:
        return "";
    }
  } catch (e) {
    logError(`hook ${event}`, e);
    return "";
  }
}

const context = (text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });

/** Copies new transcript lines into the queue, using the identity the session started with. */
function captureSession(input: HookInput, { store, machine, env }: HookDeps): CaptureResult | null {
  const { session_id: sessionId, transcript_path: transcriptPath } = input;
  if (!sessionId || !transcriptPath) return null;
  const cursor = store.getCursor(transcriptPath);
  const cwd = cursor?.cwd ?? input.cwd;
  if (!cwd) return null;
  const ident: FolderIdentity = cursor
    ? { repo: cursor.repo, subpath: cursor.subpath, root: cursor.cwd, isGit: false }
    : folderIdentity(cwd, machine ?? "");
  return captureTranscript(store, { sessionId, transcriptPath, cwd }, ident, { env });
}

type Left = () => number;

async function sessionStart(input: HookInput, deps: HookDeps, spawn: (args: string[]) => void): Promise<string> {
  const { store, api } = deps;
  ensureCliLink(); // keeps ~/.cerebro/bin/cerebro (used by launchd and the skill) on the current binary
  if (!api) return context(NOT_CONFIGURED_CONTEXT);
  if (!(Date.now() - Date.parse(store.get("lastSyncAt") ?? "") < SYNC_EVERY_MS)) spawn(["sync"]);
  const cwd = input.cwd;
  if (!cwd) return "";

  const deadline = Date.now() + NETWORK_BUDGET_MS;
  const left: Left = () => deadline - Date.now();
  const online = await verifyInstance(store, api, left);

  const machine = deps.machine ?? (online ? await fetchMachine(store, api, left) : null);
  const ident = folderIdentity(cwd, machine ?? "");
  // A path identity names the machine; without its name we cannot tell which folder this is.
  if (!machine && ident.repo.startsWith("path:")) return "";

  let binding: Binding | null | undefined;
  let live = false;
  if (online && left() >= MIN_CALL_MS) {
    try {
      binding = (await api.resolve(ident.repo, ident.subpath, { timeoutMs: left() })).binding;
      store.cacheBinding(ident.repo, ident.subpath, binding);
      live = true;
    } catch (e) {
      logError("SessionStart resolve", e);
    }
  }
  if (!live) binding = store.cachedBinding(ident.repo, ident.subpath)?.binding;

  if (binding?.status !== "declined") registerCursor(store, input, ident, binding ?? null);
  if (binding === undefined) return ""; // offline and never seen: nothing useful to say
  if (binding === null) return live ? context(UNKNOWN_FOLDER_CONTEXT) : "";
  if (binding.status === "declined") return "";

  const recent = await recentSessions(store, api, binding, ident, online, left);
  const scopeName = await scopeNameFor(store, api, binding, recent, online, left);
  const blocked = store.get("blocked") as BlockedReason | undefined;
  const brief = buildBrief(
    binding, scopeName, recent,
    { pending: store.pendingCount(), quarantined: store.quarantineCount() },
    blocked && PROBLEMS[blocked] ? [PROBLEMS[blocked]] : [],
  );
  if (!store.get(`imported:${ident.repo}|${ident.subpath}`)) spawn(["import", "--cwd", cwd]);
  return context(brief);
}

/** True when the configured server is the pinned instance; until then no request carries the token. */
async function verifyInstance(store: Store, api: ApiClient, left: Left): Promise<boolean> {
  if (store.get("blocked") === "instance_mismatch" || left() < MIN_CALL_MS) return false;
  try {
    return (await checkInstance(store, api, { timeoutMs: left() })) === "ok";
  } catch (e) {
    logError("SessionStart health", e);
    return false;
  }
}

async function fetchMachine(store: Store, api: ApiClient, left: Left): Promise<string | null> {
  if (left() < MIN_CALL_MS) return null;
  try {
    const { machine } = await api.status({ timeoutMs: left() });
    if (typeof machine !== "string" || !machine) return null;
    store.set("machine", machine);
    return machine;
  } catch (e) {
    logError("SessionStart status", e);
    return null;
  }
}

/** Starts tracking this transcript so later hooks and sweeps capture it; reopens a resumed one. */
function registerCursor(store: Store, input: HookInput, ident: FolderIdentity, binding: Binding | null): void {
  const { transcript_path: path, session_id: sessionId, cwd } = input;
  if (!path || !sessionId || !cwd) return;
  const existing = store.getCursor(path);
  if (!existing) {
    store.setCursor(path, {
      source: claudeCodeSource.id, sessionId, offset: 0, line: 0, state: null,
      bindingId: binding?.id ?? null, cwd, repo: ident.repo, subpath: ident.subpath,
    });
  } else if (existing.done) {
    store.setCursor(path, existing);
  }
}

async function recentSessions(
  store: Store, api: ApiClient, binding: Binding, ident: FolderIdentity, online: boolean, left: Left,
): Promise<SessionView[]> {
  const key = `recent:${ident.repo}|${ident.subpath}`;
  if (online && left() >= MIN_CALL_MS) {
    try {
      // A project binding is locked to its project server-side; a client-only one is narrowed to its client here.
      const narrow = !binding.projectId && binding.clientId ? { clientId: binding.clientId } : {};
      const { sessions } = await api.sessions({ repo: ident.repo, subpath: ident.subpath, limit: 5, ...narrow }, { timeoutMs: left() });
      store.set(key, JSON.stringify(sessions));
      return sessions;
    } catch (e) {
      logError("SessionStart sessions", e);
    }
  }
  try {
    const cached = JSON.parse(store.get(key) ?? "[]");
    return Array.isArray(cached) ? cached : [];
  } catch {
    return [];
  }
}

/** "Client / Project" or "Client": from recent sessions, else the cache, else one catalog lookup. */
async function scopeNameFor(
  store: Store, api: ApiClient, binding: Binding, recent: SessionView[], online: boolean, left: Left,
): Promise<string> {
  const key = `scopeName:${binding.id}`;
  let name: string | null = null;
  if (binding.projectId) {
    const s = recent.find((r) => r.clientName && r.projectName);
    if (s) name = `${s.clientName} / ${s.projectName}`;
  } else if (binding.clientId) {
    name = recent.find((r) => r.clientName)?.clientName ?? null;
  } else {
    return "no client (all clients are visible)";
  }
  if (!name) name = store.get(key) ?? null;
  if (!name && online) name = await lookupScopeName(api, binding, left);
  if (name) {
    store.set(key, name);
    return name;
  }
  return binding.projectId ? "a project" : "a client";
}

async function lookupScopeName(api: ApiClient, binding: Binding, left: Left): Promise<string | null> {
  try {
    if (!binding.clientId || left() < MIN_CALL_MS) return null;
    const client = (await api.listClients({ timeoutMs: left() })).clients.find((c) => c.id === binding.clientId);
    if (!client) return null;
    if (!binding.projectId) return client.name;
    if (left() < MIN_CALL_MS) return null;
    const project = (await api.listProjects(client.id, { timeoutMs: left() })).projects.find((p) => p.id === binding.projectId);
    return project ? `${client.name} / ${project.name}` : null;
  } catch (e) {
    logError("SessionStart scope name", e);
    return null;
  }
}
