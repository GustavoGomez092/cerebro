import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cerebroHome } from "./paths";

export interface ClientConfig { serverUrl: string; token: string }

const configPath = () => join(cerebroHome(), "config.json");

/** All-or-nothing per source, never mixed: env (plugin options or CEREBRO_*) when it has both url and token, else config.json when it has both; null otherwise. */
export function loadClientConfig(env: Record<string, string | undefined> = process.env): ClientConfig | null {
  const envUrl = env.CLAUDE_PLUGIN_OPTION_SERVER_URL || env.CEREBRO_SERVER_URL;
  const envToken = env.CLAUDE_PLUGIN_OPTION_TOKEN || env.CEREBRO_TOKEN;
  if (envUrl && envToken) return { serverUrl: envUrl, token: envToken };
  try {
    const f = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof f?.serverUrl === "string" && f.serverUrl && typeof f?.token === "string" && f.token) return { serverUrl: f.serverUrl, token: f.token };
  } catch { /* missing or unreadable file means unconfigured */ }
  return null;
}

export function saveClientConfig(c: ClientConfig): void {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ serverUrl: c.serverUrl, token: c.token }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
