import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getDbStats, getOverview } from "../../lib/api";
import { ago, bytes, count, duration, ms, when } from "../../lib/format";

const OVERVIEW_EVERY_MS = 7000;
const DB_EVERY_MS = 60_000;

export const Route = createFileRoute("/_authed/")({
  loader: async () => {
    const [overview, db] = await Promise.all([getOverview(), getDbStats()]);
    return { overview, db };
  },
  component: Dashboard,
});

/** Re-fetches `fn` every `everyMs` while the tab is visible. */
function usePolled<T>(initial: T, fn: () => Promise<T>, everyMs: number) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try { const v = await fn(); if (!stopped) { setValue(v); setError(null); setAt(Date.now()); } }
      catch (e) { if (!stopped) setError((e as Error).message || "refresh failed"); }
    };
    const t = setInterval(tick, everyMs);
    return () => { stopped = true; clearInterval(t); };
  }, [everyMs]);
  return { value, error, at };
}

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  return <span className={`dot ${tone}`} aria-hidden />;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function Dashboard() {
  const loaded = Route.useLoaderData();
  const live = usePolled(loaded.overview, () => getOverview(), OVERVIEW_EVERY_MS);
  const dbLive = usePolled(loaded.db, () => getDbStats(), DB_EVERY_MS);
  const o = live.value;
  const db = dbLive.value;
  const s = o.status;
  const sum = s.summariser;
  const embedTone = s.embedder.pausedUntil ? "warn" : s.embedder.lastError && !s.embedder.lastSuccessAt ? "bad" : "ok";
  const sumTone = !sum ? "idle" : !sum.enabled ? "idle" : sum.paused ? (sum.paused.reason === "budget" ? "warn" : "bad") : "ok";

  return (
    <main className="page">
      <div className="page-head">
        <h1>Dashboard</h1>
        <span className="muted small">{live.error ? <span className="error">Refresh failed: {live.error}</span> : `Updated ${ago(new Date(live.at).toISOString())}, every ${OVERVIEW_EVERY_MS / 1000} s`}</span>
      </div>

      <section className="grid three">
        <div className="card">
          <h2>Server</h2>
          <ul className="kv">
            <li><span><Dot tone={o.health.db ? "ok" : "bad"} /> Database</span><span>{o.health.db ? "connected" : "down"}</span></li>
            <li><span>Uptime</span><span>{duration(o.health.uptimeSeconds)}</span></li>
            <li><span>Started</span><span>{when(o.health.startedAt)}</span></li>
            <li><span>API version</span><span>{o.health.apiVersion}</span></li>
            <li><span>Instance</span><span className="mono small">{String(o.health.instanceId).slice(0, 8)}</span></li>
          </ul>
        </div>
        <div className="card">
          <h2>Embedder</h2>
          <ul className="kv">
            <li><span><Dot tone={embedTone} /> Worker</span><span>{s.embedder.pausedUntil ? `paused until ${when(s.embedder.pausedUntil)}` : "running"}</span></li>
            <li><span>Last success</span><span>{ago(s.embedder.lastSuccessAt)}</span></li>
            {s.embedder.fallback && <li><span><Dot tone={s.embedder.fallback.state === "ok" ? "ok" : "warn"} /> Zima</span><span>{s.embedder.fallback.state}</span></li>}
            {(s.embedder.endpoints ?? []).map((e: any) => (
              <li key={e.machine}><span><Dot tone={e.state === "up" ? "ok" : e.state === "unknown" ? "idle" : "warn"} /> {e.machine}</span><span>{e.state}</span></li>
            ))}
            {s.embedder.lastError && <li className="wrap"><span>Last error</span><span className="error small">{s.embedder.lastError}</span></li>}
          </ul>
        </div>
        <div className="card">
          <h2>Summariser</h2>
          {!sum ? <p className="muted">Not configured.</p> : (
            <ul className="kv">
              <li><span><Dot tone={sumTone} /> State</span><span>{!sum.enabled ? "disabled" : sum.paused ? `paused: ${sum.paused.reason}` : "running"}</span></li>
              <li><span>Last run</span><span>{ago(sum.lastRunAt)}</span></li>
              <li><span>Budget (5 h)</span><span>{count(sum.budget.used)} / {count(sum.budget.limit)}</span></li>
              <li><span>Login expires</span><span>{when(sum.credentialExpiresAt)}</span></li>
              {sum.lastError && <li className="wrap"><span>Last error</span><span className="error small">{sum.lastError}</span></li>}
            </ul>
          )}
        </div>
      </section>

      <section className="grid two">
        <div className="card">
          <h2>Database <span className="muted small">{dbLive.error ? `(refresh failed)` : `every ${DB_EVERY_MS / 1000} s`}</span></h2>
          <div className="stats">
            <Stat label="Size on disk" value={bytes(db.bytes)} />
            <Stat label="Sessions" value={count(db.counts.sessions)} />
            <Stat label="Events" value={count(db.counts.events)} />
            <Stat label="Chunks" value={count(db.counts.chunks)} />
            <Stat label="Summaries" value={count(db.counts.summaries)} />
            <Stat label="Clients" value={count(db.counts.clients)} />
            <Stat label="Projects" value={count(db.counts.projects)} />
          </div>
        </div>
        <div className="card">
          <h2>Searches per minute</h2>
          <div className="stats">
            <Stat label="Last minute" value={count(o.queries.perMinute.m1)} />
            <Stat label="Last 5 min" value={(o.queries.perMinute.m5 / 5).toFixed(1)} hint={`${o.queries.perMinute.m5} total`} />
            <Stat label="Last 15 min" value={(o.queries.perMinute.m15 / 15).toFixed(1)} hint={`${o.queries.perMinute.m15} total`} />
          </div>
          <h3>Throughput</h3>
          <div className="stats">
            <Stat label="Events / min" value={count(o.throughput.eventsPerMinute)} />
            <Stat label="Chunks embedded / min" value={count(o.throughput.chunksEmbeddedPerMinute)} />
            <Stat label="Summaries / hour" value={count(o.throughput.summariesLastHour)} />
          </div>
          <h3>Queues</h3>
          <div className="stats">
            <Stat label="Embed waiting" value={count(o.throughput.queues.embed.pending)} hint={`${o.throughput.queues.embed.dead} dead · oldest ${duration(s.queue.oldestWaitSeconds.live)} live`} />
            <Stat label="Summaries waiting" value={count(o.throughput.queues.summary.live + o.throughput.queues.summary.imported)} hint={`${o.throughput.queues.summary.live} live · ${o.throughput.queues.summary.imported} imported · ${o.throughput.queues.summary.dead} dead`} />
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Active queries</h2>
        <h3>Searches in progress</h3>
        {o.queries.active.length === 0 ? <p className="muted">None right now.</p> : (
          <table>
            <thead><tr><th>Query</th><th>Machine</th><th>Started</th><th>Elapsed</th></tr></thead>
            <tbody>{o.queries.active.map((q: any) => (
              <tr key={q.id}><td className="clip">{q.query}</td><td>{q.machine}</td><td>{when(q.startedAt)}</td><td>{ms(q.elapsedMs)}</td></tr>
            ))}</tbody>
          </table>
        )}
        <h3>Database activity</h3>
        {o.queries.database.length === 0 ? <p className="muted">Nothing running.</p> : (
          <table>
            <thead><tr><th>PID</th><th>State</th><th>SQL</th><th>Wait</th><th>Elapsed</th></tr></thead>
            <tbody>{o.queries.database.map((q: any) => (
              <tr key={q.pid}><td>{q.pid}</td><td>{q.state}</td><td className="clip mono small">{q.query}</td><td className="small">{q.wait ?? ""}</td><td>{ms(q.elapsedMs)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Chat usage</h2>
        <p className="muted small">Chat runs <code>claude -p</code> on the same Max plan as the summariser, outside the summariser's budget share.</p>
        <div className="stats">
          <Stat label={`Tokens, last ${o.chat.window.hours} h`} value={count(o.chat.window.tokens)} hint={`${o.chat.window.runs} answers`} />
          <Stat label="Tokens since restart" value={count(o.chat.sinceStart.tokens)} hint={`${o.chat.sinceStart.runs} answers`} />
          <Stat label="Last answer" value={o.chat.lastRun ? o.chat.lastRun.outcome : "–"} hint={o.chat.lastRun ? `${count(o.chat.lastRun.tokens)} tokens · ${ago(o.chat.lastRun.at)}` : undefined} />
        </div>
        {o.chat.lastLimit && (
          <p className="warn-box">Usage limit hit {ago(o.chat.lastLimit.at)}{o.chat.lastLimit.resetAt ? `; resets ${when(o.chat.lastLimit.resetAt)}` : ""}.</p>
        )}
      </section>
    </main>
  );
}
