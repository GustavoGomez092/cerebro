import { test, expect } from "bun:test";
import { authedApp, freshDb } from "./helpers";
import { boundFolder, ev, sess, ingest } from "./fixtures";
import { revokeToken } from "../src/auth";
import { connect } from "../src/db";
import { createApp } from "../src/http/app";
import { fakeEmbedder } from "../src/embed/fake";
import { redactSession } from "../src/redact-session";

test("a revoked token is told apart from an unknown one", async () => {
  const t = await authedApp();
  try {
    expect(await (await t.call("GET", "/v1/status", undefined, "cbr_nope")).json()).toMatchObject({ error: "unauthorized" });
    await revokeToken(t.sql, "test-mac");
    const res = await t.call("GET", "/v1/status");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "token_revoked" });
  } finally { await t.drop(); }
});

test("health reports version and instance, and ok:false when the database is down", async () => {
  const t = await authedApp();
  try {
    const h = await (await t.call("GET", "/health", undefined, null)).json();
    const [{ instance_id }] = await t.sql`select instance_id from settings`;
    expect(h).toEqual({ ok: true, db: true, apiVersion: 1, instanceId: instance_id });
    const dead = createApp({ sql: connect("postgres://x:y@127.0.0.1:1/none"), embedder: fakeEmbedder(), log: () => {} });
    const res = await dead.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: false });
  } finally { await t.drop(); }
});

test("unexpected errors return an envelope and log no user content", async () => {
  const lines: string[] = [];
  const t = await authedApp({ deps: { log: (l) => lines.push(l) } });
  try {
    t.app.get("/v1/boom", () => { throw new Error("SECRET-USER-CONTENT"); });
    t.app.get("/v1/baddata", async () => { await t.sql`select ${"not a number"}::int`; return new Response("unreachable"); });
    const boom = await t.call("GET", "/v1/boom");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "internal", message: "internal error" });
    const bad = await t.call("GET", "/v1/baddata");
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toBe("invalid_data");
    expect(lines.join("\n")).not.toContain("SECRET-USER-CONTENT");
    expect(lines.join("\n")).not.toContain("not a number");
    expect((await t.call("GET", "/v1/nothing-here")).status).toBe(404);
  } finally { await t.drop(); }
});

test("each request writes one access-log line and touches last_used_at", async () => {
  const lines: string[] = [];
  const t = await authedApp({ deps: { log: (l) => lines.push(l) } });
  try {
    await t.call("GET", "/v1/status?x=secret");
    const entry = JSON.parse(lines.find((l) => l.includes('"path":"/v1/status"'))!);
    expect(entry).toMatchObject({ machine: "test-mac", method: "GET", path: "/v1/status", status: 200 });
    expect(typeof entry.ms).toBe("number");
    expect(lines.join("\n")).not.toContain("secret");
    const [m] = await t.sql`select last_used_at from machines`;
    expect(m.last_used_at).not.toBeNull();
  } finally { await t.drop(); }
});

test("only ingest accepts large bodies", async () => {
  const t = await authedApp();
  try {
    const res = await t.call("POST", "/v1/search", { query: "x".repeat(100_000), scope: "open" });
    expect(res.status).toBe(413);
  } finally { await t.drop(); }
});

test("redactSession scrubs a leaked secret from events and the search index", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [ev("s1", 1, "user", "the code word is PINEAPPLE-42"), ev("s1", 2, "tool_call", "", { toolName: "Bash", toolInput: { cmd: "echo PINEAPPLE-42" } })] });
    const r = await redactSession(t.sql, "s1", "PINEAPPLE-\\d+");
    expect(r.events).toBe(2);
    const dump = JSON.stringify(await t.sql`select text, tool_input from events`) + JSON.stringify(await t.sql`select text, extra_terms from chunks`);
    expect(dump).not.toContain("PINEAPPLE");
    expect(dump).toContain("[REDACTED:manual]");
    const [{ q }] = await t.sql`select count(*)::int as q from embed_queue q join chunks c on c.id = q.chunk_id where c.session_id = 's1'`;
    expect(q).toBeGreaterThan(0);
  } finally { await t.drop(); }
});

test("token create warns not to run it inside a recorded session", async () => {
  const db = await freshDb();
  try {
    const p = Bun.spawnSync(["bun", "server/src/cli.ts", "token", "create", "cli-mac"], { env: { ...process.env, DATABASE_URL: db.url } });
    const out = p.stdout.toString();
    expect(out).toContain("cbr_");
    expect(out.toLowerCase()).toContain("recorded");
  } finally { await db.drop(); }
});

test("pgState reads the SQLSTATE of a real statement timeout", async () => {
  const { pgState } = await import("../src/db");
  const db = await freshDb();
  try {
    const err = await db.sql.begin(async (tx) => {
      await tx`set local statement_timeout = '10ms'`;
      await tx`select pg_sleep(1)`;
    }).catch((e) => e);
    expect(pgState(err)).toBe("57014");
    expect(pgState(new Error("x"))).toBeNull();
  } finally { await db.drop(); }
});

test("redactSession also scrubs the session's summaries, re-queues their embeddings and marks the scope's state for rebuild", async () => {
  const { endSession } = await import("../src/ingest");
  const { claimSummaryJob } = await import("../src/summarise/jobs");
  const { runClaude } = await import("../src/summarise/claude");
  const { summariseJob } = await import("../src/summarise/summarise");
  const { scopeKey, updateState } = await import("../src/summarise/state");
  const run = (input: any) => runClaude(input, {
    ...process.env, SUMMARISER_CMD: "bun server/test/fakes/fake-claude.ts", FAKE_CLAUDE_MODE: "ok",
  } as NodeJS.ProcessEnv);
  const budget = { share: 0.2, windowTokens: 2_000_000 };
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await ingest(t, {
      sessions: [sess("s1", binding.id)],
      events: [ev("s1", 1, "user", "the staging password is PINEAPPLE-42 remember it"), ev("s1", 2, "assistant", "Noted the staging password")],
    });
    await endSession(t.sql, "s1", new Date().toISOString());
    expect(await summariseJob(t.sql, t.embedder, (await claimSummaryJob(t.sql))!, { run, budget })).toMatchObject({ status: "done" });
    // The model put the secret in the title too.
    await t.sql`update summaries set title = 'Staging password PINEAPPLE-42'`;
    expect(await updateState(t.sql, scope, [], { run, budget })).toMatchObject({ status: "updated" });
    const [sum] = await t.sql`select id from summaries`;
    const dumpSummaries = async () => JSON.stringify(await t.sql`select title, body, text from summaries`);
    const dumpState = async () => JSON.stringify(await t.sql`select doc, text from project_states`);
    expect(await dumpSummaries()).toContain("PINEAPPLE-42");
    expect(await dumpState()).toContain("PINEAPPLE-42");
    expect(await t.sql`select 1 from summary_embeddings`).toHaveLength(1);
    const search = async () => (await (await t.call("POST", "/v1/search", { query: "PINEAPPLE-42", scope: "open", include: "summaries" })).json()).hits;
    expect((await search()).length).toBeGreaterThan(0);

    const r = await redactSession(t.sql, "s1", "PINEAPPLE-\\d+");
    expect(r.summaries).toBe(1);
    expect(r.states).toBe(1);

    expect(await dumpSummaries()).not.toContain("PINEAPPLE");
    expect(await dumpSummaries()).toContain("[REDACTED:manual]");
    const [s] = await t.sql`select title, tsv::text as tsv from summaries`;
    expect(s.title).toBe("Staging password [REDACTED:manual]");
    expect(s.tsv.toLowerCase()).not.toContain("pineapple");
    // The old vector was made from the secret: dropped, so the loop's sweep re-embeds the cleaned text.
    expect(await t.sql`select 1 from summary_embeddings where summary_id = ${sum.id}`).toHaveLength(0);
    expect(JSON.stringify(await search())).not.toContain("PINEAPPLE");
    // The state no longer shows the secret and is rebuilt (from the cleaned summaries) on the next update.
    expect(await dumpState()).not.toContain("PINEAPPLE");
    const [st] = await t.sql`select dirty, source_summary_ids from project_states where scope = ${scope}`;
    expect(st.dirty).toBe(true);
    expect(st.source_summary_ids).toHaveLength(0);
    expect(await updateState(t.sql, scope, [], { run, budget })).toMatchObject({ status: "updated" });
    expect(await dumpState()).not.toContain("PINEAPPLE");
  } finally { await t.drop(); }
});
