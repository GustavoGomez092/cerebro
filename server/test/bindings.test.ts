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
    const b2 = (await (await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active", clientId: B.id })).json()).binding;
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
