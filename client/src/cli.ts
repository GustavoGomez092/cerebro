import { ApiClient } from "./api";
import { loadClientConfig } from "./config";
import { flush, type FlushOptions } from "./flush";
import { handleHook, HOOK_EVENTS, type HookEvent } from "./hooks";
import { importFolder } from "./importer";
import { logError } from "./log";
import { installSchedule, removeSchedule } from "./schedule";
import { addToInbox } from "./sources/generic";
import { Store } from "./store";
import { syncAllSources } from "./sync";

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
        // "done"/"nothing" mean /health matched the pinned instance, so the token may be sent.
        if ((r.outcome === "done" || r.outcome === "nothing") && !store.get("machine")) {
          try {
            const { machine } = await api.status({ timeoutMs: MACHINE_TIMEOUT_MS });
            if (machine) store.set("machine", machine);
          } catch (e) {
            logError("flush status", e);
          }
        }
        await Bun.write(Bun.stdout, JSON.stringify(r) + "\n");
      } finally {
        store.close();
      }
    } catch (e) {
      logError("flush", e);
    }
  },
};

/** The server's name for this Mac (cached in state `machine`), or null when it cannot be had. */
async function machineName(store: Store, api: ApiClient | null): Promise<string | null> {
  const cached = store.get("machine");
  if (cached || !api) return cached ?? null;
  try {
    const { machine } = await api.status({ timeoutMs: MACHINE_TIMEOUT_MS });
    if (typeof machine !== "string" || !machine) return null;
    store.set("machine", machine);
    return machine;
  } catch (e) {
    logError("machine name", e);
    return null;
  }
}

const say = (out: unknown) => Bun.write(Bun.stdout, (typeof out === "string" ? out : JSON.stringify(out)) + "\n");
const complain = (msg: string) => Bun.write(Bun.stderr, `cerebro: ${msg}\n`);

const importCommand: Command = {
  usage: "import --cwd <dir>   (upload this folder's past conversations)",
  async run(args) {
    const i = args.indexOf("--cwd");
    const cwd = i >= 0 ? args[i + 1] : undefined;
    if (!cwd) { await complain("usage: cerebro import --cwd <dir>"); return; }
    const config = loadClientConfig();
    if (!config) return;
    const store = new Store();
    try {
      const api = new ApiClient(config);
      const machine = await machineName(store, api);
      await say(await importFolder(store, api, cwd, machine ?? ""));
    } finally {
      store.close();
    }
  },
};

/** Syncs every agent's history; works unconfigured or offline too (uploads then wait for a later flush). */
async function runSync(): Promise<void> {
  const config = loadClientConfig();
  const store = new Store();
  try {
    const api = config ? new ApiClient(config) : null;
    const machine = await machineName(store, api);
    await say(await syncAllSources(store, api, machine ?? ""));
  } finally {
    store.close();
  }
}

const syncCommand: Command = {
  usage: "sync   (record new Codex, Gemini, subagent and inbox history of opted-in folders)",
  run: runSync,
};

const importFileCommand: Command = {
  usage: "import-file <path> [--agent <name>]   (hand over a cerebro-jsonl v1 file, see docs/cerebro-jsonl.md)",
  async run(args) {
    const i = args.indexOf("--agent");
    const agent = i >= 0 ? args[i + 1] : undefined;
    const [path] = args.filter((_, j) => i < 0 || (j !== i && j !== i + 1));
    if (!path || (i >= 0 && !agent)) { await complain("usage: cerebro import-file <path> [--agent <name>]"); return; }
    try {
      await say(addToInbox(path, { agent }));
    } catch (e) {
      await complain((e as Error).message);
      return;
    }
    await runSync();
  },
};

const scheduleCommand: Command = {
  usage: "schedule [--off]   (run `cerebro sync` every 30 minutes via launchd, or stop doing so)",
  async run(args) {
    if (args.includes("--off")) {
      await say(removeSchedule() ? "removed the sync schedule" : "no sync schedule was installed");
      return;
    }
    try {
      await say(`cerebro sync scheduled every 30 minutes: ${installSchedule()}`);
    } catch (e) {
      await complain((e as Error).message);
    }
  },
};

export const COMMANDS: Record<string, Command> = {
  hook,
  flush: flushCommand,
  import: importCommand,
  sync: syncCommand,
  "import-file": importFileCommand,
  schedule: scheduleCommand,
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
