import { Fragment, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getSessionSummaries, searchAll } from "../../lib/api";
import { count, when } from "../../lib/format";

export const Route = createFileRoute("/_authed/chat")({ component: ChatPage });

type Step = { label: string };
type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; steps: Step[]; status: "streaming" | "done" | "error" | "stopped"; note?: string };

/** Splits an SSE stream into {event, data} records. */
async function* sse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: ?(.*)$/m.exec(block)?.[1] ?? "message";
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data: ?/, "")).join("\n");
      try { yield { event, data: JSON.parse(data || "{}") }; } catch { /* skip */ }
    }
  }
}

function errorNote(e: { kind?: string; message?: string; resetAt?: string | null }): string {
  switch (e.kind) {
    case "usage_limit": return `The Max plan's usage limit is reached${e.resetAt ? `; it resets ${when(e.resetAt)}` : ""}. Summaries wait too.`;
    case "auth": return "Claude on the server is not logged in (run claude auth login in cerebro-server).";
    case "timeout": return "No answer in time; the run was stopped.";
    case "unavailable": return "Claude is unavailable right now (CLI or network).";
    default: return e.message || "The chat failed.";
  }
}

function ChatPage() {
  const [tab, setTab] = useState<"chat" | "search">("chat");
  return (
    <main className="page">
      <div className="page-head">
        <h1>{tab === "chat" ? "Chat" : "Search"}</h1>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Ask Claude</button>
          <button role="tab" aria-selected={tab === "search"} className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>Plain search</button>
        </div>
      </div>
      <div hidden={tab !== "chat"}><Chat /></div>
      <div hidden={tab !== "search"}><Search /></div>
    </main>
  );
}

function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const updateLast = (fn: (t: Extract<Turn, { role: "assistant" }>) => Extract<Turn, { role: "assistant" }>) =>
    setTurns((ts) => {
      const last = ts[ts.length - 1];
      return last?.role === "assistant" ? [...ts.slice(0, -1), fn(last)] : ts;
    });

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const question = input.trim();
    if (!question || running) return;
    // Earlier finished turns as plain text (tool steps aren't sent), then the new question; the server caps them.
    const history = turns
      .filter((t) => t.role === "user" || (t.status === "done" && t.content))
      .map((t) => ({ role: t.role, content: t.content }))
      .slice(-12);
    const messages = [...history, { role: "user" as const, content: question }];
    setTurns((ts) => [...ts, { role: "user", content: question }, { role: "assistant", content: "", steps: [], status: "streaming" }]);
    setInput("");
    setRunning(true);
    const c = new AbortController();
    ctrl.current = c;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }), signal: c.signal });
      if (res.status === 401) { window.location.assign("/login"); return; }
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        updateLast((t) => ({ ...t, status: "error", note: err.error === "chat_busy" ? "Another answer is in progress. Try again when it ends." : err.message ?? `Error ${res.status}` }));
        return;
      }
      for await (const { event, data } of sse(res.body)) {
        if (event === "text") updateLast((t) => ({ ...t, content: t.content + data.text }));
        else if (event === "tool") updateLast((t) => ({ ...t, steps: [...t.steps, { label: data.label }] }));
        else if (event === "done") updateLast((t) => ({ ...t, status: "done", note: `${count(data.tokens)} tokens · ${data.model ?? "model unknown"} · ${(data.durationMs / 1000).toFixed(1)} s` }));
        else if (event === "error") updateLast((t) => ({ ...t, status: "error", note: errorNote(data) }));
        bottom.current?.scrollIntoView({ block: "end" });
      }
      updateLast((t) => (t.status === "streaming" ? { ...t, status: "error", note: "The answer was cut off." } : t));
    } catch {
      updateLast((t) => ({ ...t, status: c.signal.aborted ? "stopped" : "error", note: c.signal.aborted ? "Stopped." : "The connection dropped." }));
    } finally {
      setRunning(false);
      ctrl.current = null;
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  return (
    <div className="chat">
      {turns.length === 0 && (
        <div className="card muted">
          <p>Ask about any client or project. Claude answers from Cerebro's recorded sessions, summaries and project states, and cites client, project, session and date.</p>
          <p className="small">For example: <em>What did we do for Cadco last week?</em> · <em>What's the state of EDA 2.0?</em> · <em>Which clients use WordPress?</em></p>
        </div>
      )}
      <div className="turns">
        {turns.map((t, i) => t.role === "user" ? (
          <div key={i} className="turn user"><div className="bubble">{t.content}</div></div>
        ) : (
          <div key={i} className="turn assistant">
            {t.steps.length > 0 && (
              <ul className="steps">{t.steps.map((s, j) => (
                <li key={j}>{s.label}{t.status === "streaming" && j === t.steps.length - 1 && !t.content ? "…" : ""}</li>
              ))}</ul>
            )}
            <div className="bubble answer">{t.content || (t.status === "streaming" ? <span className="muted">Thinking…</span> : null)}</div>
            {t.note && <div className={`note ${t.status === "error" ? "error" : "muted"}`}>{t.note}</div>}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={send}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} rows={2} maxLength={8000}
          placeholder="Ask about a client or project… (Enter to send, Shift+Enter for a new line)" />
        {running
          ? <button type="button" className="secondary" onClick={() => ctrl.current?.abort()}>Stop</button>
          : <button type="submit" disabled={!input.trim()}>Send</button>}
        {turns.length > 0 && !running && <button type="button" className="link" onClick={() => setTurns([])}>New chat</button>}
      </form>
    </div>
  );
}

/** ts_headline's <b> marks as <mark>; everything else as text (never HTML). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<b>|<\/b>)/);
  let on = false;
  return <>{parts.map((p, i) => {
    if (p === "<b>") { on = true; return null; }
    if (p === "</b>") { on = false; return null; }
    return on ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>;
  })}</>;
}

function Search() {
  const [query, setQuery] = useState("");
  const [include, setInclude] = useState<"all" | "summaries" | "raw">("all");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, any>>({});

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try { setResult(await searchAll({ data: { query, include } })); setOpen({}); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function toggle(sessionId: string | null, key: string) {
    if (!sessionId) return;
    if (open[key]) { setOpen(({ [key]: _, ...rest }) => rest); return; }
    setOpen((o) => ({ ...o, [key]: "loading" }));
    try { const s = await getSessionSummaries({ data: sessionId }); setOpen((o) => ({ ...o, [key]: s })); }
    catch { setOpen((o) => ({ ...o, [key]: { error: true } })); }
  }

  return (
    <div>
      <form className="searchbar" onSubmit={run}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search every client and project" maxLength={2000} />
        <select value={include} onChange={(e) => setInclude(e.target.value as any)}>
          <option value="all">Summaries and raw</option>
          <option value="summaries">Summaries only</option>
          <option value="raw">Raw only</option>
        </select>
        <button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && (
        <>
          <p className="muted small">{result.hits.length} results{result.degraded ? ` · partial (${result.degradedReasons.join(", ")})` : ""}</p>
          <ul className="hits">{result.hits.map((h: any) => {
            const key = `${h.kind}:${h.summaryId ?? h.chunkId}`;
            const o = open[key];
            return (
              <li key={key} className="card hit">
                <button className="hit-head" onClick={() => toggle(h.sessionId, key)} disabled={!h.sessionId}>
                  <span className="chip">{h.kind}</span>
                  <strong>{h.clientName ?? "?"}{h.projectName ? ` / ${h.projectName}` : ""}</strong>
                  <span className="muted small">{when(h.tsFrom)} · {h.machine ?? "?"} · <span className="mono">{h.sessionId ?? "history"}</span></span>
                </button>
                <p className="snippet"><Snippet text={h.snippet} /></p>
                {h.cwd && <p className="muted small mono">{h.cwd}</p>}
                {o === "loading" && <p className="muted small">Loading summary…</p>}
                {o && o !== "loading" && (o.error ? <p className="error small">Couldn't load the summary.</p> : o.summaries.length === 0 ? <p className="muted small">This session has no summary yet.</p> : (
                  <div className="summary">{o.summaries.map((s: any) => (
                    <div key={s.id}>
                      <h4>{s.title}</h4>
                      <p>{s.overview}</p>
                      {s.decisions.length > 0 && <><h5>Decisions</h5><ul>{s.decisions.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul></>}
                      {s.facts.length > 0 && <><h5>Facts</h5><ul>{s.facts.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul></>}
                      {s.openThreads.length > 0 && <><h5>Open threads</h5><ul>{s.openThreads.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul></>}
                    </div>
                  ))}</div>
                ))}
              </li>
            );
          })}</ul>
        </>
      )}
    </div>
  );
}
