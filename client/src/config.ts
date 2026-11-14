import { chmodSync, closeSync, fchmodSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { cerebroHome } from "./paths";

export interface ClientConfig { serverUrl: string; token: string }

const configPath = () => join(cerebroHome(), "config.json");

/** The config given in the environment (plugin options or CEREBRO_*), only when it has both url and token. */
function envConfig(env: Record<string, string | undefined>): ClientConfig | null {
  const serverUrl = env.CLAUDE_PLUGIN_OPTION_SERVER_URL || env.CEREBRO_SERVER_URL;
  const token = env.CLAUDE_PLUGIN_OPTION_TOKEN || env.CEREBRO_TOKEN;
  return serverUrl && token ? { serverUrl, token } : null;
}

function fileConfig(): ClientConfig | null {
  try {
    const f = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof f?.serverUrl === "string" && f.serverUrl && typeof f?.token === "string" && f.token) return { serverUrl: f.serverUrl, token: f.token };
  } catch { /* missing or unreadable file means unconfigured */ }
  return null;
}

/** All-or-nothing per source, never mixed: env (plugin options or CEREBRO_*) when it has both url and token, else config.json when it has both; null otherwise. */
export function loadClientConfig(env: Record<string, string | undefined> = process.env): ClientConfig | null {
  return envConfig(env) ?? fileConfig();
}

/**
 * Writes config.json atomically and owner-only: a fresh 0600 temp file in the same folder, renamed over the
 * old one, so the token is never readable by others, not even briefly, and an older 0644 file is replaced.
 */
export function saveClientConfig(c: ClientConfig): void {
  const path = configPath();
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600); // umask can only narrow the mode; this pins it exactly
    writeSync(fd, JSON.stringify({ serverUrl: c.serverUrl, token: c.token }, null, 2) + "\n");
    closeSync(fd);
    renameSync(tmp, path);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Keeps config.json equal to the complete config in `env` (the plugin settings a hook runs with), so launchd's
 * sync and commands run from Bash, which never see those settings, use the current ones. Does nothing when
 * the env has no complete config; leaves an equal file untouched (only tightening its mode to 0600).
 */
export function syncConfigFile(env: Record<string, string | undefined>): void {
  const want = envConfig(env);
  if (!want) return;
  const have = fileConfig();
  if (have && have.serverUrl === want.serverUrl && have.token === want.token) {
    const path = configPath();
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    return;
  }
  saveClientConfig(want);
}
