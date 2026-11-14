/** Shared test data builders. */
export const REPO = "github.com/acme/app";

export async function boundFolder(t: any, opts: { client?: string; project?: string; repo?: string; subpath?: string } = {}) {
  const client = await (await t.call("POST", "/v1/clients", { name: opts.client ?? "Acme" })).json();
  const project = opts.project
    ? await (await t.call("POST", "/v1/projects", { clientId: client.id, name: opts.project })).json()
    : null;
  const res = await t.call("PUT", "/v1/bindings", {
    repo: opts.repo ?? REPO, subpath: opts.subpath ?? "", status: "active", clientId: client.id, projectId: project?.id,
  });
  const { binding } = await res.json();
  return { client, project, binding };
}

export const ts = (seq: number, day = 1) => new Date(Date.UTC(2026, 10, day, 12, 0, seq)).toISOString();

export const ev = (sessionId: string, seq: number, kind: string, text: string, extra: object = {}) => ({
  key: `${sessionId}:${seq}`, sessionId, seq, ts: ts(seq), kind, text, ...extra,
});

export const sess = (id: string, bindingId: string, extra: object = {}) => ({
  id, bindingId, cwd: "/work/app", repo: REPO, subpath: "", startedAt: "2026-11-01T12:00:00.000Z", ...extra,
});

/** Posts an ingest batch and returns the parsed body, asserting HTTP 200. */
export async function ingest(t: any, batch: { sessions?: any[]; events?: any[] }) {
  const res = await t.call("POST", "/v1/ingest", { sessions: batch.sessions ?? [], events: batch.events ?? [] });
  if (res.status !== 200) throw new Error(`ingest ${res.status}: ${await res.text()}`);
  return res.json();
}
