import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess, ingest, REPO } from "./fixtures";

test("ingest is idempotent across replays and overlaps", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const batch1 = { sessions: [sess("s1", binding.id)], events: [1, 2, 3].map((i) => ev("s1", i, "user", `m${i}`)) };
    expect(await ingest(t, batch1)).toEqual({ sessions: 1, inserted: 3, duplicates: 0, rejected: [] });
    expect(await ingest(t, batch1)).toEqual({ sessions: 1, inserted: 0, duplicates: 3, rejected: [] });
    const batch2 = { events: [3, 4, 5].map((i) => ev("s1", i, "assistant", `m${i}`)) };
    expect(await ingest(t, batch2)).toEqual({ sessions: 0, inserted: 2, duplicates: 1, rejected: [] });
    const [{ n }] = await t.sql`select count(*)::int as n from events`;
    expect(n).toBe(5);
    const [{ c }] = await t.sql`select count(*)::int as c from chunks`;
    const [{ q }] = await t.sql`select count(*)::int as q from embed_queue`;
    expect(q).toBe(c);
    await ingest(t, batch1);
    expect((await t.sql`select count(*)::int as c from chunks`)[0].c).toBe(c);
  } finally { await t.drop(); }
});

test("the same key in two sessions is two events", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const r = await ingest(t, {
      sessions: [sess("a", binding.id), sess("b", binding.id)],
      events: [{ ...ev("a", 1, "user", "x"), key: "k" }, { ...ev("b", 1, "user", "y"), key: "k" }],
    });
    expect(r.inserted).toBe(2);
  } finally { await t.drop(); }
});

test("bad items are rejected one by one and the rest is stored", async () => {
  const t = await authedApp();
  let deep: any = "x";
  for (let i = 0; i < 100; i++) deep = { d: deep };
  try {
    const { binding } = await boundFolder(t);
    const r = await ingest(t, {
      sessions: [sess("s1", binding.id, { cwd: "/w\u0000x" })],
      events: [
        ev("s1", 1, "user", "good"),
        { ...ev("s1", 2, "user", "bad year"), ts: "0000-01-01T00:00:00Z" },
        ev("s1", 3, "tool_call", "", { toolName: "Ba\u0000sh", toolInput: { cmd: "emoji \ud83d" } }),
        { ...ev("s1", 4, "tool_call", ""), toolInput: deep },
        { ...ev("s1", 5, "user", "k"), key: "nul\u0000key" },
        { ...ev("s1", 6, "weird", "x") },
        ev("ghost", 1, "user", "no such session"),
      ],
    });
    expect(r.inserted).toBe(3);
    expect(r.rejected).toEqual(expect.arrayContaining([
      { key: "s1:2", sessionId: "s1", code: "invalid_event" },
      { key: "s1:4", sessionId: "s1", code: "too_deep" },
      { key: "s1:6", sessionId: "s1", code: "invalid_event" },
      { key: "ghost:1", sessionId: "ghost", code: "unknown_session" },
    ]));
    expect(r.rejected).toHaveLength(4);
    const rows = await t.sql`select key, tool_name, tool_input->>'cmd' as cmd from events order by seq`;
    expect(rows.map((x: any) => x.key)).toEqual(["s1:1", "s1:3", "nul�key"]);
    expect(rows[1].tool_name).toBe("Ba�sh");
    expect(rows[1].cmd).toBe("emoji �");
    const [s] = await t.sql`select cwd from sessions`;
    expect(s.cwd).toBe("/w�x");
  } finally { await t.drop(); }
});

test("oversized batches are refused so the client splits them", async () => {
  const t = await authedApp();
  try {
    const events = Array.from({ length: 2001 }, (_, i) => ev("s", i, "user", "x"));
    const res = await t.call("POST", "/v1/ingest", { sessions: [], events });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("batch_too_large");
  } finally { await t.drop(); }
});

test("unknown bindings and foreign path identities reject that session and its events", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const r = await ingest(t, {
      sessions: [sess("s1", crypto.randomUUID()), sess("s2", binding.id, { repo: "path:other-mac:/x" }), sess("s3", binding.id)],
      events: [ev("s1", 1, "user", "a"), ev("s2", 1, "user", "b"), ev("s3", 1, "user", "c")],
    });
    expect(r.inserted).toBe(1);
    expect(r.rejected).toEqual(expect.arrayContaining([
      { sessionId: "s1", code: "unknown_binding" },
      { sessionId: "s2", code: "foreign_path_identity" },
      { key: "s1:1", sessionId: "s1", code: "unknown_session" },
      { key: "s2:1", sessionId: "s2", code: "unknown_session" },
    ]));
  } finally { await t.drop(); }
});

test("sessions for a declined folder are kept (held)", async () => {
  const t = await authedApp();
  try {
    const { binding } = await (await t.call("PUT", "/v1/bindings", { repo: "d", subpath: "", status: "declined" })).json();
    const r = await ingest(t, { sessions: [sess("s1", binding.id, { repo: "d" })], events: [ev("s1", 1, "user", "x")] });
    expect(r).toMatchObject({ inserted: 1, rejected: [] });
  } finally { await t.drop(); }
});

test("secrets are redacted before storage", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, {
      sessions: [sess("s1", binding.id)],
      events: [
        ev("s1", 1, "user", "my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
        ev("s1", 2, "tool_call", "", { toolName: "Bash", toolInput: { command: "curl -H 'Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'" } }),
      ],
    });
    const dump = JSON.stringify(await t.sql`select text, tool_input from events`) + JSON.stringify(await t.sql`select text from chunks`);
    expect(dump).not.toContain("sk-ant-api03");
    expect(dump).not.toContain("ghp_ABCDEF");
    expect(dump).toContain("[REDACTED");
  } finally { await t.drop(); }
});

test("unknown fields are kept in meta; identities are normalised", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, {
      sessions: [sess("s1", binding.id, { repo: "git@github.com:Acme/App.git", subpath: "/apps//web/", gitBranch: "main" })],
      events: [ev("s1", 1, "assistant", "hi", { uuid: "u-1", model: "claude-x", meta: { thinking: "hmm" } })],
    });
    const [s] = await t.sql`select repo, subpath, meta from sessions`;
    expect(s).toMatchObject({ repo: REPO, subpath: "apps/web" });
    expect(s.meta).toEqual({ gitBranch: "main" });
    const [e] = await t.sql`select meta from events`;
    expect(e.meta).toEqual({ uuid: "u-1", model: "claude-x", thinking: "hmm" });
  } finally { await t.drop(); }
});

test("new events chunk immediately and queue by priority", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, {
      sessions: [sess("live", binding.id), sess("old", binding.id, { imported: true })],
      events: [ev("live", 1, "user", "now"), ev("old", 1, "user", "then"), ev("old", 2, "tool_result", "out", { toolName: "Read" })],
    });
    const rows = await t.sql`select c.session_id, q.priority from chunks c join embed_queue q on q.chunk_id = c.id order by c.session_id`;
    expect(rows.map((r: any) => [r.session_id, r.priority])).toEqual([["live", 0], ["old", 1]]);
  } finally { await t.drop(); }
});

test("last_event_at only moves forward and later events reopen an ended session", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [ev("s1", 5, "user", "late")] });
    await ingest(t, { events: [ev("s1", 1, "user", "early")] });
    let [s] = await t.sql`select last_event_at from sessions`;
    expect(s.last_event_at.toISOString()).toBe(ev("s1", 5, "user", "").ts);
    expect((await t.call("POST", "/v1/sessions/s1/end", { endedAt: ev("s1", 6, "user", "").ts })).status).toBe(200);
    await ingest(t, { events: [ev("s1", 9, "user", "resumed")] });
    [s] = await t.sql`select ended_at from sessions`;
    expect(s.ended_at).toBeNull();
  } finally { await t.drop(); }
});

test("end session on an unknown id is 404", async () => {
  const t = await authedApp();
  try {
    expect((await t.call("POST", "/v1/sessions/nope/end", { endedAt: "2026-11-01T13:00:00.000Z" })).status).toBe(404);
  } finally { await t.drop(); }
});
