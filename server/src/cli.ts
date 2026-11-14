import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { createToken, revokeToken } from "./auth";
import { redactSession } from "./redact-session";
import { requeueDead } from "./worker";
import { requeueDeadSummaries } from "./summarise/jobs";
import { ollamaEmbedder } from "./embed/ollama";
import { toVector, type Embedder } from "./embed/embedder";
import type { SQL } from "bun";

const usage = [
  "usage: bun server/src/cli.ts token create|revoke <machine>",
  "       bun server/src/cli.ts token list",
  "       bun server/src/cli.ts redact <session-id> [regex]   # scrub a leaked secret from a session, its summaries and states",
  "       bun server/src/cli.ts migrate                       # apply pending migrations and exit (run before starting a new server)",
  "       bun server/src/cli.ts requeue-missing-embeddings    # queue chunks (and re-embed summaries) that have no vector, e.g. after restoring a dump",
  "       bun server/src/cli.ts requeue-dead                  # retry chunks and summary jobs that were given up on",
  "       bun server/src/cli.ts requeue-dead-summaries        # retry dead summary jobs only",
].join("\n");

/**
 * Queues (priority 1) every chunk that has neither a vector nor a queue row, and re-embeds summaries
 * without a vector. `summaries` is null when the summary tables do not exist yet.
 */
export async function requeueMissingEmbeddings(
  sql: SQL,
  makeEmbedder: () => Promise<Embedder> = async () => {
    const c = loadConfig(process.env);
    if (!c.embedUrl) throw new Error("EMBED_URL is required to re-embed summaries");
    return ollamaEmbedder(c.embedUrl, c.embedModel, c.embedDims);
  },
): Promise<{ chunks: number; summaries: number | null }> {
  const queued = await sql`
    insert into embed_queue (chunk_id, priority)
    select c.id, 1 from chunks c
    where not exists (select 1 from chunk_embeddings e where e.chunk_id = c.id)
    on conflict (chunk_id) do nothing
    returning chunk_id`;
  const [{ present }] = await sql`select to_regclass('public.summary_embeddings') is not null and to_regclass('public.summaries') is not null as present`;
  if (!present) return { chunks: queued.length, summaries: null };
  let done = 0;
  let embedder: Embedder | undefined;
  for (;;) {
    const batch = await sql`
      select s.id, s.title, s.text from summaries s
      where not exists (select 1 from summary_embeddings e where e.summary_id = s.id)
      order by s.id limit 32`;
    if (!batch.length) break;
    embedder ??= await makeEmbedder();
    const vectors = await embedder.embed(batch.map((r: any) => `${r.title}\n${r.text}`));
    if (vectors.length !== batch.length)
      throw new Error(`embedder returned ${vectors.length} vector(s) for ${batch.length} summaries; aborting without writing this batch`);
    for (let i = 0; i < batch.length; i++)
      await sql`insert into summary_embeddings (summary_id, embedding) values (${batch[i].id}, ${toVector(vectors[i])}::halfvec) on conflict do nothing`;
    done += batch.length;
  }
  return { chunks: queued.length, summaries: done };
}

async function main(argv: string[]) {
  const [area, cmd, name] = argv;
  if (area === "migrate") {
    const sql = connect(loadConfig(process.env).databaseUrl);
    try {
      const applied = await migrate(sql);
      console.log(applied.length ? `migrated: ${applied.join(", ")}` : "migrations up to date");
    } finally { await sql.close(); }
    return;
  }
  if (area === "requeue-missing-embeddings") {
    const sql = connect(loadConfig(process.env).databaseUrl);
    try {
      await migrate(sql);
      const r = await requeueMissingEmbeddings(sql);
      console.log(`queued ${r.chunks} chunk(s) for embedding`);
      console.log(r.summaries === null ? "summaries: skipped (no summary_embeddings table)" : `re-embedded ${r.summaries} summary(ies)`);
    } finally { await sql.close(); }
    return;
  }
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
      console.log(`scrubbed ${r.summaries} summary(ies), queued for re-embedding; ${r.states} project state(s) scrubbed and marked for rebuild`);
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

if (import.meta.main) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
