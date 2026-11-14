import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess } from "./fixtures";

test("ingest is idempotent across replays and overlaps", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const batch1 = { sessions: [sess("s1", binding.id)], events: [1, 2, 3].map((i) => ev("s1", i, "user", `m${i}`)) };
    expect(await (await t.call("POST", "/v1/ingest", batch1)).json()).toEqual({ sessions: 1, inserted: 3, duplicates: 0 });
    expect(await (await t.call("POST", "/v1/ingest", batch1)).json()).toEqual({ sessions: 1, inserted: 0, duplicates: 3 });
    const batch2 = { sessions: [], events: [3, 4, 5].map((i) => ev("s1", i, "assistant", `m${i}`)) };
    expect(await (await t.call("POST", "/v1/ingest", batch2)).json()).toEqual({ sessions: 0, inserted: 2, duplicates: 1 });
    const [{ n }] = await t.sql`select count(*)::int as n from events`;
    expect(n).toBe(5);
    const [s] = await t.sql`select last_event_at, machine_id from sessions where id = 's1'`;
    expect(s.last_event_at.toISOString()).toBe(ev("s1", 5, "user", "").ts);
    expect(s.machine_id).toBe(t.machineId);
  } finally { await t.drop(); }
});

test("events for an unknown session reject the whole batch", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const res = await t.call("POST", "/v1/ingest", {
      sessions: [sess("s1", binding.id)], events: [ev("s1", 1, "user", "ok"), ev("ghost", 1, "user", "x")],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "unknown_session", sessionId: "ghost" });
    const [{ n }] = await t.sql`select count(*)::int as n from events`;
    expect(n).toBe(0);
  } finally { await t.drop(); }
});

test("unknown or declined binding is 422", async () => {
  const t = await authedApp();
  try {
    const missing = await t.call("POST", "/v1/ingest", { sessions: [sess("s1", crypto.randomUUID())], events: [] });
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toBe("unknown_binding");
    const { binding } = await (await t.call("PUT", "/v1/bindings", { repo: "d", subpath: "", status: "declined" })).json();
    const declined = await t.call("POST", "/v1/ingest", { sessions: [sess("s2", binding.id)], events: [] });
    expect(declined.status).toBe(422);
    expect((await declined.json()).error).toBe("binding_declined");
  } finally { await t.drop(); }
});

test("malformed batches are 400", async () => {
  const t = await authedApp();
  try {
    expect((await t.call("POST", "/v1/ingest", { sessions: [], events: [{ key: "k" }] })).status).toBe(400);
    expect((await t.call("POST", "/v1/ingest", { sessions: [], events: [ev("s", 1, "weird", "x")] })).status).toBe(400);
  } finally { await t.drop(); }
});

test("end session sets ended_at; unknown is 404", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await t.call("POST", "/v1/ingest", { sessions: [sess("s1", binding.id)], events: [] });
    expect((await t.call("POST", "/v1/sessions/s1/end", { endedAt: "2026-11-01T13:00:00.000Z" })).status).toBe(200);
    const [s] = await t.sql`select ended_at from sessions where id = 's1'`;
    expect(s.ended_at.toISOString()).toBe("2026-11-01T13:00:00.000Z");
    expect((await t.call("POST", "/v1/sessions/nope/end", { endedAt: "2026-11-01T13:00:00.000Z" })).status).toBe(404);
  } finally { await t.drop(); }
});

test("tool_input round-trips as json", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await t.call("POST", "/v1/ingest", {
      sessions: [sess("s1", binding.id)],
      events: [ev("s1", 1, "tool_call", "", { toolName: "Bash", toolInput: { command: "ls -la" } })],
    });
    const [r] = await t.sql`select tool_name, tool_input->>'command' as cmd from events`;
    expect(r).toEqual({ tool_name: "Bash", cmd: "ls -la" });
  } finally { await t.drop(); }
});
