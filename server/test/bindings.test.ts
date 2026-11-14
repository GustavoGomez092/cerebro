import { test, expect } from "bun:test";
import { authedApp } from "./helpers";

async function setup() {
  const t = await authedApp();
  const A = await (await t.call("POST", "/v1/clients", { name: "Acme" })).json();
  const B = await (await t.call("POST", "/v1/clients", { name: "Beta" })).json();
  const P = await (await t.call("POST", "/v1/projects", { clientId: B.id, name: "Web" })).json();
  return { t, A, B, P };
}
const resolve = async (t: any, repo: string, subpath: string) =>
  (await (await t.call("GET", `/v1/bindings/resolve?repo=${encodeURIComponent(repo)}&subpath=${encodeURIComponent(subpath)}`)).json()).binding;

test("clients and projects are idempotent by name", async () => {
  const { t, A, B, P } = await setup();
  try {
    expect((await (await t.call("POST", "/v1/clients", { name: "Acme" })).json()).id).toBe(A.id);
    expect((await (await t.call("POST", "/v1/projects", { clientId: B.id, name: "Web" })).json()).id).toBe(P.id);
    const names = (await (await t.call("GET", "/v1/clients")).json()).clients.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Personal", "Acme", "Beta"]));
    const projects = (await (await t.call("GET", `/v1/clients/${B.id}/projects`)).json()).projects;
    expect(projects.map((p: any) => p.name)).toEqual(["Web"]);
  } finally { await t.drop(); }
});

test("most specific binding wins, on path boundaries", async () => {
  const { t, A, B, P } = await setup();
  try {
    expect((await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active", clientId: A.id })).status).toBe(200);
    expect((await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "apps/web", status: "active", clientId: B.id, projectId: P.id })).status).toBe(200);
    expect((await resolve(t, "r", "apps/web/src")).projectId).toBe(P.id);
    expect((await resolve(t, "r", "apps/web")).projectId).toBe(P.id);
    expect((await resolve(t, "r", "apps/website")).clientId).toBe(A.id);
    expect((await resolve(t, "r", "")).clientId).toBe(A.id);
    expect(await resolve(t, "other", "")).toBeNull();
  } finally { await t.drop(); }
});

test("declined binding resolves as declined", async () => {
  const { t } = await setup();
  try {
    await t.call("PUT", "/v1/bindings", { repo: "d", subpath: "", status: "declined" });
    const b = await resolve(t, "d", "x");
    expect(b.status).toBe("declined");
    expect(b.clientId).toBeNull();
  } finally { await t.drop(); }
});

test("invalid bindings are rejected", async () => {
  const { t, A, P } = await setup();
  try {
    expect((await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active", clientId: A.id, projectId: P.id })).status).toBe(400);
    expect((await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active" })).status).toBe(400);
    expect((await t.call("PUT", "/v1/bindings", { repo: "", status: "active", clientId: A.id })).status).toBe(400);
  } finally { await t.drop(); }
});

test("re-binding updates the same binding row", async () => {
  const { t, A, B } = await setup();
  try {
    const b1 = (await (await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active", clientId: A.id })).json()).binding;
    const refused = await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active", clientId: B.id });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("rebind_required");
    const b2 = (await (await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active", clientId: B.id, rebind: true })).json()).binding;
    expect(b2.id).toBe(b1.id);
    expect(b2.clientId).toBe(B.id);
  } finally { await t.drop(); }
});

test("repoint moves identity, refuses collisions", async () => {
  const { t, A } = await setup();
  try {
    const b = (await (await t.call("PUT", "/v1/bindings", { repo: "old", subpath: "", status: "active", clientId: A.id })).json()).binding;
    await t.call("PUT", "/v1/bindings", { repo: "taken", subpath: "", status: "active", clientId: A.id });
    const res = await t.call("PATCH", `/v1/bindings/${b.id}/identity`, { repo: "new", subpath: "" });
    expect(res.status).toBe(200);
    expect((await resolve(t, "new", "")).id).toBe(b.id);
    expect(await resolve(t, "old", "")).toBeNull();
    expect((await t.call("PATCH", `/v1/bindings/${b.id}/identity`, { repo: "taken", subpath: "" })).status).toBe(409);
  } finally { await t.drop(); }
});

import { boundFolder, sess, ev, ingest } from "./fixtures";

test("identities are normalised on write and read", async () => {
  const { t, A } = await setup();
  try {
    const { binding } = await (await t.call("PUT", "/v1/bindings", { repo: "https://GitHub.com/Acme/Site.git", subpath: "/apps//web/", status: "active", clientId: A.id })).json();
    expect(binding).toMatchObject({ repo: "github.com/acme/site", subpath: "apps/web" });
    for (const sub of ["apps/web", "apps/web/", "/apps/web/src", "./apps/web"])
      expect((await resolve(t, "git@github.com:acme/site.git", sub))?.id).toBe(binding.id);
    expect((await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "apps/../secret", status: "active", clientId: A.id })).status).toBe(400);
  } finally { await t.drop(); }
});

test("another machine's path identity cannot be written", async () => {
  const { t, A } = await setup();
  try {
    const res = await t.call("PUT", "/v1/bindings", { repo: "path:other-mac:/Users/x/notes", subpath: "", status: "active", clientId: A.id });
    expect(res.status).toBe(403);
    expect((await t.call("PUT", "/v1/bindings", { repo: "path:test-mac:/Users/x/notes", subpath: "", status: "active", clientId: A.id })).status).toBe(200);
  } finally { await t.drop(); }
});

test("declining a folder with history needs confirmation and then holds it", async () => {
  const { t } = await setup();
  try {
    const { binding } = await boundFolder(t, { repo: "github.com/acme/hist", client: "Hist" });
    await ingest(t, { sessions: [sess("s1", binding.id, { repo: "github.com/acme/hist" })], events: [] });
    expect((await t.call("PUT", "/v1/bindings", { repo: "github.com/acme/hist", subpath: "", status: "declined" })).status).toBe(409);
    expect((await t.call("PUT", "/v1/bindings", { repo: "github.com/acme/hist", subpath: "", status: "declined", rebind: true })).status).toBe(200);
  } finally { await t.drop(); }
});

test("every binding change is recorded in history", async () => {
  const { t, A, B } = await setup();
  try {
    const b = (await (await t.call("PUT", "/v1/bindings", { repo: "h", subpath: "", status: "active", clientId: A.id })).json()).binding;
    await t.call("PUT", "/v1/bindings", { repo: "h", subpath: "", status: "active", clientId: B.id, rebind: true });
    await t.call("PATCH", `/v1/bindings/${b.id}/identity`, { repo: "h2", subpath: "" });
    const rows = await t.sql`select action, machine_id, before->>'clientId' as before_client, after->>'clientId' as after_client from binding_history where binding_id = ${b.id} order by id`;
    expect(rows.map((r: any) => r.action)).toEqual(["create", "rebind", "repoint"]);
    expect(rows[1]).toMatchObject({ before_client: A.id, after_client: B.id, machine_id: t.machineId });
  } finally { await t.drop(); }
});

test("adopt moves earlier sessions under a new, more specific binding", async () => {
  const { t, A, B, P } = await setup();
  try {
    const root = (await (await t.call("PUT", "/v1/bindings", { repo: "github.com/m/mono", subpath: "", status: "active", clientId: A.id })).json()).binding;
    await ingest(t, { sessions: [
      sess("web1", root.id, { repo: "github.com/m/mono", subpath: "apps/web/src" }),
      sess("lib1", root.id, { repo: "github.com/m/mono", subpath: "lib" }),
    ] });
    const web = (await (await t.call("PUT", "/v1/bindings", { repo: "github.com/m/mono", subpath: "apps/web", status: "active", clientId: B.id, projectId: P.id })).json()).binding;
    const res = await t.call("POST", `/v1/bindings/${web.id}/adopt`);
    expect(await res.json()).toEqual({ moved: 1 });
    const rows = await t.sql`select id, binding_id from sessions order by id`;
    expect(rows.map((r: any) => [r.id, r.binding_id])).toEqual([["lib1", root.id], ["web1", web.id]]);
  } finally { await t.drop(); }
});

test("a single session can be moved to another active binding", async () => {
  const { t, A, B } = await setup();
  try {
    const a = (await (await t.call("PUT", "/v1/bindings", { repo: "ra", subpath: "", status: "active", clientId: A.id })).json()).binding;
    const b = (await (await t.call("PUT", "/v1/bindings", { repo: "rb", subpath: "", status: "active", clientId: B.id })).json()).binding;
    const d = (await (await t.call("PUT", "/v1/bindings", { repo: "rd", subpath: "", status: "declined" })).json()).binding;
    await ingest(t, { sessions: [sess("s1", a.id, { repo: "ra" })], events: [ev("s1", 1, "user", "x")] });
    expect((await t.call("PATCH", "/v1/sessions/s1", { bindingId: b.id })).status).toBe(200);
    expect((await t.sql`select binding_id from sessions`)[0].binding_id).toBe(b.id);
    expect((await t.call("PATCH", "/v1/sessions/s1", { bindingId: d.id })).status).toBe(400);
    expect((await t.call("PATCH", "/v1/sessions/nope", { bindingId: b.id })).status).toBe(404);
  } finally { await t.drop(); }
});
