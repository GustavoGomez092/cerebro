import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `$CEREBRO_HOME` or `~/.cerebro`; created with mode 0700. */
export function cerebroHome(): string {
  const dir = process.env.CEREBRO_HOME || join(homedir(), ".cerebro");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to chmod; carry on */ }
  return dir;
}
