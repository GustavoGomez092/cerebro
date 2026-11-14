import { ApiClient } from "./api";
import { loadClientConfig } from "./config";
import { flush, type FlushOptions } from "./flush";
import { handleHook, HOOK_EVENTS, type HookEvent } from "./hooks";
import { checkInstance } from "./instance";
import { logError } from "./log";
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

export const COMMANDS: Record<string, Command> = {
  hook,
  flush: flushCommand,
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
