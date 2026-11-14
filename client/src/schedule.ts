import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logError } from "./log";
import { cerebroHome } from "./paths";
import { isCompiledBinary } from "./spawn";

export const SCHEDULE_LABEL = "dev.cerebro.sync";
export const SYNC_INTERVAL_SECONDS = 1800;

export interface ScheduleOptions {
  home?: string;
  /** The command that runs cerebro (default: the stable ~/.cerebro/bin/cerebro link). */
  program?: string[];
  /** Runs `launchctl <args>` and returns its exit code; tests pass a recorder. */
  launchctl?: (args: string[]) => number;
  uid?: number;
}

export const schedulePath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${SCHEDULE_LABEL}.plist`);
/** A path to cerebro that survives plugin updates (the plugin's own binary lives in a versioned cache folder). */
export const cliLinkPath = () => join(cerebroHome(), "bin", "cerebro");

/**
 * Points ~/.cerebro/bin/cerebro at the running compiled binary, replacing a link to an older one.
 * Returns the link, or null under `bun cli.ts` (nothing stable to point at) or on failure. Never throws.
 */
export function ensureCliLink(opts: { target?: string; compiled?: boolean } = {}): string | null {
  if (!(opts.compiled ?? isCompiledBinary())) return null;
  const target = opts.target ?? process.execPath;
  try {
    const link = cliLinkPath();
    let current: string | null = null;
    try { current = readlinkSync(link); } catch { /* missing, or not a link */ }
    if (current === target) return link;
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
    rmSync(link, { force: true });
    symlinkSync(target, link);
    return link;
  } catch (e) {
    logError("cli link", e);
    return null;
  }
}

function runLaunchctl(args: string[]): number {
  return Bun.spawnSync(["launchctl", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode ?? 1;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(program: string[], log: string): string {
  const env = process.env.CEREBRO_HOME
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>CEREBRO_HOME</key>\n    <string>${xml(process.env.CEREBRO_HOME)}</string>\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[...program, "sync"].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key>
  <integer>${SYNC_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
${env}  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Installs (or replaces) a launchd agent that runs `cerebro sync` every 30 minutes; returns the plist path. */
export function installSchedule(opts: ScheduleOptions = {}): string {
  const path = schedulePath(opts.home);
  const logs = join(cerebroHome(), "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plist(opts.program ?? [cliLinkPath()], join(logs, "sync.log")));
  const launchctl = opts.launchctl ?? runLaunchctl;
  const domain = `gui/${opts.uid ?? process.getuid!()}`;
  launchctl(["bootout", domain, path]); // unload an older copy; fails harmlessly when none is loaded
  const code = launchctl(["bootstrap", domain, path]);
  if (code !== 0) throw new Error(`launchctl bootstrap ${domain} ${path} failed with exit code ${code}`);
  return path;
}

/** Unloads and deletes the launchd agent; false when it was not installed. */
export function removeSchedule(opts: Omit<ScheduleOptions, "program"> = {}): boolean {
  const path = schedulePath(opts.home);
  if (!existsSync(path)) return false;
  (opts.launchctl ?? runLaunchctl)(["bootout", `gui/${opts.uid ?? process.getuid!()}`, path]);
  rmSync(path, { force: true });
  return true;
}
