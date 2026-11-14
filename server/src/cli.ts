import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { createToken, revokeToken } from "./auth";
import { redactSession } from "./redact-session";
import { requeueDead } from "./worker";
import { requeueDeadSummaries } from "./summarise/jobs";

const usage = [
  "usage: bun server/src/cli.ts token create|revoke <machine>",
  "       bun server/src/cli.ts token list",
  "       bun server/src/cli.ts redact <session-id> [regex]   # scrub a leaked secret and rebuild its search index",
  "       bun server/src/cli.ts requeue-dead                  # retry chunks and summary jobs that were given up on",
  "       bun server/src/cli.ts requeue-dead-summaries        # retry dead summary jobs only",
].join("\n");

async function main(argv: string[]) {
  const [area, cmd, name] = argv;
  if (area === "requeue-dead" || area === "requeue-dead-summaries") {
    const sql = connect(loadConfig(process.env).databaseUrl);
    try {
      if (area === "requeue-dead") console.log(`requeued ${await requeueDead(sql)} chunk(s)`);
      console.log(`requeued ${await requeueDeadSummaries(sql)} summary job(s)`);
    } finally { await sql.close(); }
    return;
  }
  if (area === "redact" && cmd) {
    const sql = connect(loadConfig(process.env).databaseUrl);
    try {
      await migrate(sql);
      const r = await redactSession(sql, cmd, name);
      console.log(`redacted ${r.events} event(s); rebuilt ${r.chunks} search chunk(s), queued for re-embedding`);
    } finally { await sql.close(); }
    return;
  }
  if (area !== "token" || !cmd) throw new Error(usage);
  const sql = connect(loadConfig(process.env).databaseUrl);
  try {
    await migrate(sql);
    if (cmd === "create" && name) {
      const { token } = await createToken(sql, name);
      console.log(`Token for ${name} (shown once, store it on that machine):\n${token}`);
      console.log("Do not create tokens inside a recorded Claude Code session: the token would be saved in Cerebro's memory.");
    } else if (cmd === "revoke" && name) {
      console.log((await revokeToken(sql, name)) ? `revoked ${name}` : `no active token for ${name}`);
    } else if (cmd === "list") {
      for (const m of await sql`select name, created_at, revoked_at from machines order by name`)
        console.log(`${m.name}\tcreated ${m.created_at.toISOString()}\t${m.revoked_at ? "revoked " + m.revoked_at.toISOString() : "active"}`);
    } else throw new Error(usage);
  } finally {
    await sql.close();
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
