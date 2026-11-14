import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess } from "./fixtures";

test("events come back in seq order with tool_result truncation", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t, { project: "App" });
    await t.call("POST", "/v1/ingest", {
      sessions: [sess("s1", binding.id)],
      events: [ev("s1", 2, "assistant", "two"), ev("s1", 1, "user", "one"), ev("s1", 3, "tool_result", "r".repeat(5000), { toolName: "Read" })],
    });
    const { events } = await (await t.call("GET", "/v1/sessions/s1/events")).json();
    expect(events.map((e: any) => e.seq)).toEqual([1, 2, 3]);
    expect(events[2].truncated).toBe(true);
    expect(events[2].text.length).toBe(2000);
    expect(events[0].truncated).toBe(false);
    const full = (await (await t.call("GET", "/v1/sessions/s1/events?full=1")).json()).events;
    expect(full[2].text.length).toBe(5000);
    const span = (await (await t.call("GET", "/v1/sessions/s1/events?fromSeq=2&toSeq=2")).json()).events;
    expect(span.map((e: any) => e.text)).toEqual(["two"]);
    expect((await t.call("GET", "/v1/sessions/nope/events")).status).toBe(404);
  } finally { await t.drop(); }
});

test("sessions list filters by project and date", async () => {
  const t = await authedApp();
  try {
    const a = await boundFolder(t, { client: "Acme", project: "App", repo: "ra" });
    const b = await boundFolder(t, { client: "Beta", project: "Site", repo: "rb" });
    await t.call("POST", "/v1/ingest", { sessions: [{ ...sess("sa", a.binding.id), startedAt: "2026-10-01T00:00:00.000Z" }], events: [] });
    await t.call("POST", "/v1/ingest", { sessions: [{ ...sess("sb", b.binding.id), startedAt: "2026-10-20T00:00:00.000Z" }], events: [] });
    const list = async (q: string) => (await (await t.call("GET", `/v1/sessions${q}`)).json()).sessions;
    expect((await list("")).map((s: any) => s.id).sort()).toEqual(["sa", "sb"]);
    const [only] = await list(`?projectId=${a.project.id}`);
    expect(only).toMatchObject({ id: "sa", clientName: "Acme", projectName: "App", machine: "test-mac", cwd: "/work/app", imported: false });
    expect((await list("?from=2026-10-10T00:00:00.000Z")).map((s: any) => s.id)).toEqual(["sb"]);
  } finally { await t.drop(); }
});
