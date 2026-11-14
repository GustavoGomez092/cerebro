/** Shared test data builders. */
export async function boundFolder(t: any, opts: { client?: string; project?: string; repo?: string } = {}) {
  const client = await (await t.call("POST", "/v1/clients", { name: opts.client ?? "Acme" })).json();
  const project = opts.project
    ? await (await t.call("POST", "/v1/projects", { clientId: client.id, name: opts.project })).json()
    : null;
  const { binding } = await (await t.call("PUT", "/v1/bindings", {
    repo: opts.repo ?? "github.com/acme/app", subpath: "", status: "active", clientId: client.id, projectId: project?.id,
  })).json();
  return { client, project, binding };
}

export const ev = (sessionId: string, seq: number, kind: string, text: string, extra: object = {}) => ({
  key: `${sessionId}:${seq}`, sessionId, seq, ts: new Date(Date.UTC(2026, 10, 1, 12, 0, seq)).toISOString(), kind, text, ...extra,
});

export const sess = (id: string, bindingId: string) => ({
  id, bindingId, cwd: "/work/app", startedAt: "2026-11-01T12:00:00.000Z",
});
