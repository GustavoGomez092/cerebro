import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ApiClient } from "./api";
import { loadClientConfig, type ClientConfig } from "./config";
import { flush, type FlushOptions, type FlushResult } from "./flush";
import { handleHook, HOOK_EVENTS, type HookEvent } from "./hooks";
import { checkInstance } from "./instance";
import { logError } from "./log";
import { startMcpServer } from "./mcp";
import { Store } from "./store";

/** One CLI subcommand. Later commands are added as new entries in `COMMANDS`. */
export interface Command {
  /** One line, starting with the command name. */
  usage: string;
  run(args: string[]): Promise<void>;
}

const MACHINE_TIMEOUT_MS = 5000;

const hook: Command = {
  usage: "hook <SessionStart|Stop|PreCompact|SessionEnd>   (reads the hook's JSON on stdin)",
  async run(args) {
    let out = "";
    try {
      const event = args[0] as HookEvent;
      if (!HOOK_EVENTS.includes(event)) return;
      const input = JSON.parse(await Bun.stdin.text());
      const store = new Store();
      try {
        const config = loadClientConfig();
        out = await handleHook(event, input, {
          store,
          api: config ? new ApiClient(config) : null,
          machine: store.get("machine") ?? null,
          env: process.env,
        });
      } finally {
        store.close();
      }
    } catch (e) {
      logError(`hook ${args[0] ?? ""}`, e);
      out = "";
    }
    if (out) await Bun.write(Bun.stdout, out);
  },
};

const flushCommand: Command = {
  usage: "flush [--end <sessionId> <endedAt ISO>]   (upload the local queue)",
  async run(args) {
    try {
      const config = loadClientConfig();
      if (!config) return;
      const opts: FlushOptions = {};
      if (args[0] === "--end" && args[1] && args[2]) opts.end = { sessionId: args[1], endedAt: args[2] };
      const store = new Store();
      try {
        const api = new ApiClient(config);
        const r = await flush(store, api, opts);
        if (r.outcome === "error") logError("flush", "flush ended with an unexpected error");
        await learnMachineName(store, api);
        await Bun.write(Bun.stdout, JSON.stringify(r) + "\n");
      } finally {
        store.close();
      }
    } catch (e) {
      logError("flush", e);
    }
  },
};

/** Caches the server's name for this Mac (state `machine`), asking only a pinned, unblocked, verified instance. */
async function learnMachineName(store: Store, api: ApiClient): Promise<void> {
  if (store.get("machine") || !store.get("instanceId") || store.get("blocked")) return;
  try {
    if ((await checkInstance(store, api, { timeoutMs: MACHINE_TIMEOUT_MS })) !== "ok") return;
    const { machine } = await api.status({ timeoutMs: MACHINE_TIMEOUT_MS });
    if (machine) store.set("machine", machine);
  } catch (e) {
    logError("flush status", e);
  }
}

const mcp: Command = {
  usage: "mcp   (stdio MCP server: recall and setup tools)",
  async run() {
    try {
      await startMcpServer();
    } catch (e) {
      logError("mcp", e);
    }
  },
};

/** The status report. Never includes the token. */
export function statusText(store: Store, config: ClientConfig | null): string {
  if (!config) {
    return [
      "Cerebro: not configured",
      "Set the plugin options server_url and token (Claude Code: /plugin, then configure cerebro),",
      "or set CEREBRO_SERVER_URL and CEREBRO_TOKEN.",
      "",
    ].join("\n");
  }
  return [
    `server: ${config.serverUrl}`,
    `machine: ${store.get("machine") ?? "(unknown)"}`,
    `instance: ${store.get("instanceId") ?? "(not pinned yet)"}`,
    `queue: ${store.pendingCount()} pending, ${store.quarantineCount()} quarantined`,
    `pending session ends: ${store.pendingEnds().length}`,
    `last flush: ${store.get("lastFlushAt") ?? "never"}`,
    `blocked: ${store.get("blocked") ?? "no"}`,
    `last error: ${store.get("lastError") ?? "none"}`,
    `open cursors: ${store.openCursors().length}`,
    "",
  ].join("\n");
}

/** Lifts a block and any backoff, then runs one flush. */
export async function retryAfterBlock(store: Store, api: ApiClient): Promise<FlushResult> {
  store.set("blocked", null);
  store.set("backoffUntil", null);
  store.set("backoffMs", null);
  return flush(store, api);
}

const status: Command = {
  usage: "status [--retry]   (show upload state; --retry clears a block and flushes once)",
  async run(args) {
    const config = loadClientConfig();
    const store = new Store();
    try {
      if (config && args.includes("--retry")) {
        const r = await retryAfterBlock(store, new ApiClient(config));
        await Bun.write(Bun.stdout, `retry: ${r.outcome}\n`);
      }
      await Bun.write(Bun.stdout, statusText(store, config));
    } finally {
      store.close();
    }
  },
};

const DEFAULT_RETENTION_DAYS = 36500;

const retention: Command = {
  usage: `retention [--days N]   (set Claude Code's cleanupPeriodDays, default ${DEFAULT_RETENTION_DAYS}, so transcripts outlive the upload)`,
  async run(args) {
    const i = args.indexOf("--days");
    const days = i >= 0 ? Number(args[i + 1]) : DEFAULT_RETENTION_DAYS;
    if (!Number.isInteger(days) || days < 1) {
      await Bun.write(Bun.stdout, "--days needs a positive whole number\n");
      return;
    }
    const path = join(process.env.HOME || homedir(), ".claude", "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        settings = parsed;
      } catch {
        await Bun.write(Bun.stdout, `${path} is not valid JSON; left untouched. Fix it, then run this again.\n`);
        return;
      }
    }
    const current = settings.cleanupPeriodDays;
    await Bun.write(Bun.stdout, `cleanupPeriodDays is currently ${current === undefined ? "unset (Claude Code default: 30)" : String(current)}\n`);
    if (current === days) {
      await Bun.write(Bun.stdout, "Already set; nothing to change.\n");
      return;
    }
    settings.cleanupPeriodDays = days;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    await Bun.write(Bun.stdout, `Set cleanupPeriodDays to ${days} in ${path}\n`);
  },
};

const resetInstance: Command = {
  usage: "reset-instance   (forget the pinned server instance, for a reinstalled server)",
  async run() {
    const store = new Store();
    try {
      store.set("instanceId", null);
      if (store.get("blocked") === "instance_mismatch") store.set("blocked", null);
    } finally {
      store.close();
    }
    await Bun.write(Bun.stdout, "Cleared the pinned instance; the next upload pins whichever server it reaches.\n");
  },
};

export const COMMANDS:Record<string, Command> = {
  hook,
  flush: flushCommand,
  mcp,
  status,
  retention,
  "reset-instance": resetInstance,
};

export function usage(): string {
  return "usage: cerebro <command>\n" + Object.values(COMMANDS).map((c) => `  cerebro ${c.usage}`).join("\n") + "\n";
}

/** Runs one subcommand; unknown ones print usage. Always exits 0, so a hook can never fail a session. */
export async function main(argv: string[]): Promise<never> {
  const [name, ...args] = argv;
  const cmd = name ? COMMANDS[name] : undefined;
  try {
    if (cmd) await cmd.run(args);
    else await Bun.write(Bun.stdout, usage());
  } catch (e) {
    logError(`cli ${name ?? ""}`, e);
  }
  process.exit(0);
}

if (import.meta.main) await main(process.argv.slice(2));
