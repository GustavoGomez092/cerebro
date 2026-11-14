import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { logError } from "./log";

/** False under `bun client/src/cli.ts` (the runtime is bun itself); true in the compiled binary, whose execPath is the binary. */
export function isCompiledBinary(): boolean {
  const runtime = basename(process.execPath).replace(/\.exe$/, "");
  return runtime !== "bun" && runtime !== "bun-debug";
}

function selfArgs(): string[] {
  return isCompiledBinary() ? [] : [join(import.meta.dir, "cli.ts")];
}

/** Starts `cerebro <args>` in the background, detached from this process. Never throws. `CEREBRO_NO_SPAWN=1` makes it a no-op (tests). */
export function spawnDetached(args: string[]): void {
  if (process.env.CEREBRO_NO_SPAWN === "1") return;
  try {
    const child = spawn(process.execPath, [...selfArgs(), ...args], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", (e) => logError(`spawn ${args[0]}`, e));
    child.unref();
  } catch (e) {
    logError(`spawn ${args[0]}`, e);
  }
}
