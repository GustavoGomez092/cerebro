import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cerebroHome } from "./paths";

function write(entry: Record<string, unknown>): void {
  try {
    appendFileSync(join(cerebroHome(), "client.log"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch { /* logging must never fail a session */ }
}

export function logError(where: string, err: unknown): void {
  try {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    write({ level: "error", where, error });
  } catch { /* never throw */ }
}

export function logInfo(msg: string, data?: object): void {
  try {
    write({ level: "info", msg, ...(data ? { data } : {}) });
  } catch { /* never throw */ }
}
