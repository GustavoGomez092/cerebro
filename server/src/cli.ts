import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { createToken, revokeToken } from "./auth";
import { redactSession } from "./redact-session";
import { requeueDead } from "./worker";
import { requeueDeadSummaries } from "./summarise/jobs";
import { parseSummary, summaryEmbedText } from "./summarise/summarise";
import { runClaude, type ClaudeInput, type ClaudeRun } from "./summarise/claude";
import { SUMMARY_SCHEMA, summaryRequest } from "./summarise/prompts";
import { renderRange } from "./summarise/render";
import { record } from "./summarise/budget";
import { ollamaEmbedder } from "./embed/ollama";
import { toVector, type Embedder } from "./embed/embedder";
import type { SQL } from "bun";
import { runWebDbRole } from "./web-db-role";

const usage = [
  "usage: bun server/src/cli.ts token create|revoke <machine>",
  "       bun server/src/cli.ts token list",
  "       bun server/src/cli.ts redact <session-id> [regex]   # scrub a leaked secret from a session, its summaries and states",
  "       bun server/src/cli.ts migrate                       # apply pending migrations and exit (run before starting a new server)",
  "       bun server/src/cli.ts requeue-missing-embeddings    # queue chunks (and re-embed summaries) that have no vector, e.g. after restoring a dump",
  "       bun server/src/cli.ts requeue-dead                  # retry chunks and summary jobs that were given up on",
  "       bun server/src/cli.ts requeue-dead-summaries        # retry dead summary jobs only",
  "       bun server/src/cli.ts claude-smoke                  # one tiny real summary call through the server's runClaude (after claude auth login)",
  "       bun server/src/cli.ts web-db-role | …               # new password for cerebro_web; prints web.env's DATABASE_URL line into a pipe only",
].join("\n");

/** What to do about each failure class, for the owner at the terminal. */
const SMOKE_HINTS: Record<string, string> = {
  auth: "log in as the server's user: docker exec -it -u cerebro cerebro-server claude auth login",
  usage_limit: "the subscription is at its usage limit; try again after the reset",
  unavailable: "the CLI is missing or will not start, or the network/API is down (docker logs cerebro-server)",
  timeout: "no answer in time: the API may be slow or unreachable; try again",
  bad_output: "the CLI answered, but not in the shape the server reads: check the CLI pin in server/Dockerfile",
  failed: "the CLI reported an error: check the CLI pin in server/Dockerfile and docker logs cerebro-server",
};

/**
 * One tiny real summary call (a two-message transcript) through the server's own runClaude, summary prompt,
 * SUMMARY_SCHEMA and parseSummary: proves the login, the pinned CLI's output envelope and the schema parsing
 * in one go (M3). Charged to the budget when `sql` is given. The line names the model, tokens and login
 * expiry, or the failure class with what to do; never the prompt, the answer's text or any credential.
 */
export async function claudeSmoke(run: (input: ClaudeInput) => Promise<ClaudeRun>, sql?: SQL): Promise<{ ok: boolean; line: string }> {
  const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 12, m)).toISOString();
  const [piece] = renderRange([
    { seq: 1, ts: at(0), kind: "user", text: "Rename the config flag FOO to BAR in settings.ts.", tool_name: null, tool_input: null },
    { seq: 2, ts: at(1), kind: "assistant", text: "Renamed FOO to BAR in settings.ts and its two call sites; the tests pass.", tool_name: null, tool_input: null },
  ]);
  const started = Date.now();
  const res = await run({ ...summaryRequest(piece), schema: SUMMARY_SCHEMA });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const spent = res.ok ? res.tokens : res.tokens ?? 0;
  if (sql && spent > 0) await record(sql, spent, "summary");
  const fail = (kind: string, message: string) => ({
    ok: false, line: `FAIL ${kind}: ${message.replace(/\s+/g, " ").slice(0, 300)} (${SMOKE_HINTS[kind] ?? SMOKE_HINTS.failed})`,
  });
  if (!res.ok) return fail(res.kind, res.message);
  if (!parseSummary(res.output)) return fail("bad_output", "the answer does not match the summary schema");
  return {
    ok: true,
    line: `ok: a summary call answered in ${secs} s (model ${res.model}, ${res.tokens} tokens, login expires ${res.credentialExpiresAt ?? "unknown"})`,
  };
}

/**
 * Queues (priority 1) every chunk that has neither a vector nor a queue row, and re-embeds summaries
 * without a vector, embedding the same text as the live summariser (summaryEmbedText), so a re-embed after
 * a restore yields the same vectors. `summaries` is null when the summary tables do not exist yet.
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
    insert into embed_queue (chunk_id, priority, machine_id)
    select c.id, 1, s.machine_id from chunks c join sessions s on s.id = c.session_id
    where not exists (select 1 from chunk_embeddings e where e.chunk_id = c.id)
    on conflict (chunk_id) do nothing
    returning chunk_id`;
  const [{ present }] = await sql`select to_regclass('public.summary_embeddings') is not null and to_regclass('public.summaries') is not null as present`;
  if (!present) return { chunks: queued.length, summaries: null };
  let done = 0;
  let embedder: Embedder | undefined;
  for (;;) {
    const batch = await sql`
      select s.id, s.title, s.body from summaries s
      where not exists (select 1 from summary_embeddings e where e.summary_id = s.id)
      order by s.id limit 32`;
    if (!batch.length) break;
    embedder ??= await makeEmbedder();
    const vectors = await embedder.embed(batch.map((r: any) => summaryEmbedText(r)));
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
  if (area === "web-db-role") {
    const { databaseUrl } = loadConfig(process.env);
    const sql = connect(databaseUrl);
    try {
      await migrate(sql);
      await runWebDbRole(sql, databaseUrl, { isTTY: !!process.stdout.isTTY, write: (s) => process.stdout.write(s) });
    } finally { await sql.close(); }
    return;
  }
  if (area === "claude-smoke") {
    const config = loadConfig(process.env);
    const sql = connect(config.databaseUrl);
    try {
      const r = await claudeSmoke((input) => runClaude(input, { ...process.env, SUMMARISER_CMD: config.summariser.cmd }), sql);
      console.log(r.line);
      if (!r.ok) process.exitCode = 1;
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
