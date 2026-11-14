import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess, ingest } from "./fixtures";

async function twoProjects() {
  const t = await authedApp();
  const a = await boundFolder(t, { client: "Acme", project: "App", repo: "github.com/acme/app" });
  const b = await boundFolder(t, { client: "Beta", project: "Site", repo: "github.com/beta/site" });
  await ingest(t, { sessions: [{ ...sess("sa", a.binding.id, { repo: "github.com/acme/app" }), startedAt: "2026-10-01T00:00:00.000Z" }], events: [{ ...ev("sa", 1, "user", "a"), ts: "2026-10-01T00:05:00.000Z" }] });
  await ingest(t, { sessions: [{ ...sess("sb", b.binding.id, { repo: "github.com/beta/site" }), startedAt: "2026-10-20T00:00:00.000Z" }], events: [{ ...ev("sb", 1, "user", "b"), ts: "2026-10-20T00:05:00.000Z" }] });
  const get = (p: string) => t.call("GET", p);
  return { t, a, b, get };
}

test("reads need a folder or an explicit open scope", async () => {
  const { t, get } = await twoProjects();
  try {
    expect((await get("/v1/sessions")).status).toBe(400);
    expect((await get("/v1/sessions/sa/events")).status).toBe(400);
  } finally { await t.drop(); }
});

test("a project-locked folder lists and reads only its project", async () => {
  const { t, get } = await twoProjects();
  try {
    const list = (await (await get("/v1/sessions?repo=git@github.com:acme/app.git")).json()).sessions;
    expect(list.map((s: any) => s.id)).toEqual(["sa"]);
    expect(list[0]).toMatchObject({ clientName: "Acme", projectName: "App", machine: "test-mac", cwd: "/work/app", imported: false });
    expect((await get("/v1/sessions/sb/events?repo=github.com/acme/app")).status).toBe(404);
    expect((await get("/v1/sessions/sa/events?repo=github.com/acme/app")).status).toBe(200);
  } finally { await t.drop(); }
});

test("open scope lists everything active, filters by project and date", async () => {
  const { t, a, get } = await twoProjects();
  try {
    const list = async (q: string) => (await (await get(`/v1/sessions?scope=open${q}`)).json()).sessions.map((s: any) => s.id);
    expect((await list("")).sort()).toEqual(["sa", "sb"]);
    expect(await list(`&projectId=${a.project.id}`)).toEqual(["sa"]);
    expect(await list("&from=2026-10-10T00:00:00.000Z")).toEqual(["sb"]);
    for (const bad of ["&from=1", "&to=yesterday", "&from=2026-10-20T00:00:00Z&to=2026-10-01T00:00:00Z", "&limit=0"])
      expect((await get(`/v1/sessions?scope=open${bad}`)).status).toBe(400);
  } finally { await t.drop(); }
});

test("session list pages with a cursor", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [1, 2, 3, 4, 5].map((d) => ({ ...sess(`s${d}`, binding.id), startedAt: `2026-10-0${d}T00:00:00.000Z` })) });
    const p1 = await (await t.call("GET", "/v1/sessions?scope=open&limit=2")).json();
    expect(p1.sessions.map((s: any) => s.id)).toEqual(["s5", "s4"]);
    const p2 = await (await t.call("GET", `/v1/sessions?scope=open&limit=2&before=${encodeURIComponent(p1.next)}`)).json();
    expect(p2.sessions.map((s: any) => s.id)).toEqual(["s3", "s2"]);
  } finally { await t.drop(); }
});

test("events page by seq and truncate tool output in SQL", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, {
      sessions: [sess("s1", binding.id)],
      events: [ev("s1", 2, "assistant", "two"), ev("s1", 1, "user", "one"), ev("s1", 3, "tool_result", "r".repeat(5000), { toolName: "Read" }), ev("s1", 4, "user", "four")],
    });
    const get = async (q: string) => (await t.call("GET", `/v1/sessions/s1/events?scope=open${q}`)).json();
    const all = await get("");
    expect(all.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(all.nextSeq).toBeNull();
    expect(all.events[2]).toMatchObject({ truncated: true });
    expect(all.events[2].text.length).toBe(2000);
    const page = await get("&limit=2");
    expect(page.events.map((e: any) => e.seq)).toEqual([1, 2]);
    expect(page.nextSeq).toBe(2);
    expect((await get("&afterSeq=2&limit=1")).events.map((e: any) => e.text)).toEqual(["r".repeat(2000)]);
    expect((await get("&afterSeq=2&limit=1&full=1")).events[0].text.length).toBe(5000);
    expect((await t.call("GET", "/v1/sessions/nope/events?scope=open")).status).toBe(404);
    expect((await t.call("GET", "/v1/sessions/s1/events?scope=open&limit=5000")).status).toBe(400);
  } finally { await t.drop(); }
});

test("full=1 stops at a byte budget and hands back a cursor", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const events = [1, 2, 3, 4].map((i) => ev("s1", i, "tool_result", String(i).repeat(900_000), { toolName: "Read" }));
    for (const e of events) await ingest(t, { sessions: [sess("s1", binding.id)], events: [e] });
    const r = await (await t.call("GET", "/v1/sessions/s1/events?scope=open&full=1")).json();
    expect(r.events.map((e: any) => e.seq)).toEqual([1, 2]);
    expect(r.nextSeq).toBe(2);
  } finally { await t.drop(); }
});
