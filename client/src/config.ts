import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cerebroHome } from "./paths";

export interface ClientConfig { serverUrl: string; token: string }

const configPath = () => join(cerebroHome(), "config.json");

/** Env (plugin options, then CEREBRO_*) wins over ~/.cerebro/config.json; null when incomplete. */
export function loadClientConfig(env: Record<string, string | undefined> = process.env): ClientConfig | null {
  const envUrl = env.CLAUDE_PLUGIN_OPTION_SERVER_URL || env.CEREBRO_SERVER_URL;
  const envToken = env.CLAUDE_PLUGIN_OPTION_TOKEN || env.CEREBRO_TOKEN;
  if (envUrl && envToken) return { serverUrl: envUrl, token: envToken };
  try {
    const f = JSON.parse(readFileSync(configPath(), "utf8"));
    const serverUrl = envUrl || f?.serverUrl;
    const token = envToken || f?.token;
    if (typeof serverUrl === "string" && serverUrl && typeof token === "string" && token) return { serverUrl, token };
  } catch { /* missing or unreadable file means unconfigured */ }
  return null;
}

export function saveClientConfig(c: ClientConfig): void {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ serverUrl: c.serverUrl, token: c.token }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
