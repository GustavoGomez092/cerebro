// Creates the dashboard's owner account, or resets its password. Public sign-up is off; this is the only way in.
//
//   bun web/scripts/create-owner.ts --email you@example.com [--name "Your Name"]
//
// The password is typed at a hidden prompt (twice), or piped on stdin (its first line). It is never an argument, so
// it never lands in shell history or `ps`, and it is never printed or logged.
import { getAuth } from "../src/server/auth.server";
import { createOrResetOwner } from "../src/server/owner.server";

export function parseOwnerArgs(argv: string[]): { email: string; name: string } {
  let email = "", name = "Owner";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") email = argv[++i] ?? "";
    else if (a === "--name") name = argv[++i] ?? "";
    else if (/^-?-p(assword)?(=|$)/.test(a)) throw new Error("never pass the password as an argument: type it at the prompt or pipe it on stdin");
    else throw new Error(`unknown argument ${a.startsWith("-") ? a : "(a bare value)"}; usage: create-owner --email <email> [--name <name>]`);
  }
  if (!email) throw new Error("usage: create-owner --email <email> [--name <name>]");
  if (!name.trim()) throw new Error("--name must not be empty");
  return { email, name };
}

/** The first line of piped stdin, line ending removed (spaces kept). */
export function passwordFromPipe(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? "";
  if (!line) throw new Error("no password on stdin");
  return line;
}

/** Reads a line from the terminal without echoing it. */
async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") { done(); resolve(value); return; }
        if (ch === "\u0003") { done(); reject(new Error("cancelled")); return; }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write("\n"); };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return passwordFromPipe(await Bun.stdin.text());
  const first = await promptHidden("Password (12+ characters): ");
  const again = await promptHidden("Again: ");
  if (first !== again) throw new Error("the two passwords differ");
  return first;
}

if (import.meta.main) {
  try {
    const { email, name } = parseOwnerArgs(process.argv.slice(2));
    const password = await readPassword();
    const result = await createOrResetOwner(getAuth(), { email, name, password });
    console.log(result === "created" ? `owner created: ${email.trim().toLowerCase()}` : `password reset for ${email.trim().toLowerCase()} (its sessions were signed out)`);
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
