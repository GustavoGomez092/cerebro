import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { createToken, revokeToken } from "./auth";

const usage = "usage: bun server/src/cli.ts token create|revoke <machine> | token list";

async function main(argv: string[]) {
  const [area, cmd, name] = argv;
  if (area !== "token" || !cmd) throw new Error(usage);
  const sql = connect(loadConfig(process.env).databaseUrl);
  try {
    await migrate(sql);
    if (cmd === "create" && name) {
      const { token } = await createToken(sql, name);
      console.log(`Token for ${name} (shown once, store it on that machine):\n${token}`);
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
