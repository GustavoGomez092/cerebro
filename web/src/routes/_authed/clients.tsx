import { createFileRoute } from "@tanstack/react-router";
import { getClients } from "../../lib/api";
import { ago, count, when } from "../../lib/format";

export const Route = createFileRoute("/_authed/clients")({
  loader: () => getClients(),
  component: Clients,
});

function Clients() {
  const { clients } = Route.useLoaderData() as { clients: any[] };
  const sorted = [...clients].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.name.localeCompare(b.name));
  return (
    <main className="page">
      <div className="page-head">
        <h1>Clients</h1>
        <span className="muted small">{clients.length} clients · most recently active first</span>
      </div>
      {sorted.map((c) => (
        <section className="card" key={c.id}>
          <div className="client-head">
            <h2>{c.name}</h2>
            <span className="muted small">{count(c.sessions)} sessions · last activity {ago(c.lastActivityAt)}</span>
          </div>
          {c.projects.length === 0 ? <p className="muted">No projects.</p> : (
            <table>
              <thead><tr><th>Project</th><th>Sessions</th><th>By machine</th><th>Last activity</th></tr></thead>
              <tbody>{c.projects.map((p: any) => (
                <tr key={p.id ?? "none"}>
                  <td>{p.name}</td>
                  <td>{count(p.sessions)}</td>
                  <td>{p.machines.length === 0 ? <span className="muted">–</span> : p.machines.map((m: any) => (
                    <span className="chip" key={m.machine} title={`last activity ${when(m.lastActivityAt)}`}>{m.machine} · {m.sessions}</span>
                  ))}</td>
                  <td title={when(p.lastActivityAt)}>{ago(p.lastActivityAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      ))}
    </main>
  );
}
