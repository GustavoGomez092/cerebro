import { Component, Fragment, memo, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUp, Check, Copy, ListChecks, LoaderCircle, Square, SquarePen, TriangleAlert } from "lucide-react";
import { getSessionSummaries, searchAll } from "../../lib/api";
import { when } from "../../lib/format";
import { applyEvent, endTurn, historyFor, isRunning, newAssistantTurn, sseFrames, type AssistantTurn, type Step, type Turn } from "../../lib/chat-stream";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChatContainerContent, ChatContainerRoot } from "@/components/ui/chat-container";
import { DotsLoader, TextShimmerLoader } from "@/components/ui/loader";
import { Message, MessageAction, MessageActions, MessageContent } from "@/components/ui/message";
import { PromptInput, PromptInputAction, PromptInputActions, PromptInputTextarea } from "@/components/ui/prompt-input";
import { PromptSuggestion } from "@/components/ui/prompt-suggestion";
import { ScrollButton } from "@/components/ui/scroll-button";
import { Steps, StepsContent, StepsItem, StepsTrigger } from "@/components/ui/steps";

export const Route = createFileRoute("/_authed/chat")({ component: ChatPage });

const SUGGESTIONS = ["What do you know about JS Lab?", "What did I work on this week?", "Open threads for Elite Dental"];

function ChatPage() {
  const [tab, setTab] = useState<"chat" | "search">("chat");
  return (
    <main className={tab === "chat" ? "chat-page flex min-h-0 flex-1 flex-col" : "page"}>
      <div className={cn("page-head", tab === "chat" && "mx-auto w-full max-w-3xl px-4 pt-5")}>
        <h1>{tab === "chat" ? "Chat" : "Search"}</h1>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Ask Claude</button>
          <button role="tab" aria-selected={tab === "search"} className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>Plain search</button>
        </div>
      </div>
      {/* Both stay mounted so switching tabs keeps the conversation and the search results. */}
      <div hidden={tab !== "chat"} className="pk flex min-h-0 flex-1 flex-col"><Chat /></div>
      <div hidden={tab !== "search"}><Search /></div>
    </main>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The agent's tool calls for one answer: open while it works, folded away once the answer is finished. */
function ToolSteps({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  const last = steps[steps.length - 1];
  return (
    <Steps open={open} onOpenChange={setOpen} className="w-full">
      <StepsTrigger
        leftIcon={live ? <LoaderCircle className="size-4 animate-spin" /> : <ListChecks className="size-4" />}
        swapIconOnHover={!live}
      >
        {live && last
          ? <TextShimmerLoader text={capital(last.label)} size="md" className="font-normal" />
          : `${steps.length} lookup${steps.length === 1 ? "" : "s"} in Cerebro`}
      </StepsTrigger>
      <StepsContent>
        {steps.map((s, i) => <StepsItem key={i}>{capital(s.label)}</StepsItem>)}
      </StepsContent>
    </Steps>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageAction tooltip={copied ? "Copied" : "Copy answer"} delayDuration={100}>
      <Button
        variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Copy answer"
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageAction>
  );
}

/** If the Markdown renderer ever throws on a half-streamed answer, show it as plain text instead of losing the page. */
class PlainOnError extends Component<{ text: string; children: ReactNode }, { failedOn: string | null }> {
  state = { failedOn: null as string | null };
  static getDerivedStateFromError() { return { failedOn: "" }; }
  componentDidCatch() { this.setState({ failedOn: this.props.text }); }
  render() {
    const { failedOn } = this.state;
    if (failedOn !== null && (failedOn === "" || failedOn === this.props.text)) return <div className="whitespace-pre-wrap">{this.props.text}</div>;
    return this.props.children;
  }
}

const AssistantMessage = memo(function AssistantMessage({ turn }: { turn: AssistantTurn }) {
  const live = isRunning(turn);
  const failed = turn.status === "error";
  return (
    <Message className="w-full flex-col items-start gap-3">
      {turn.steps.length > 0 && <ToolSteps steps={turn.steps} live={live} />}
      {!turn.content && live && <DotsLoader className="my-2" />}
      {turn.content && (
        <PlainOnError text={turn.content}>
          <MessageContent markdown className="prose prose-pk w-full min-w-0 max-w-none bg-transparent p-0">
            {turn.content}
          </MessageContent>
        </PlainOnError>
      )}
      {turn.note && (failed ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{turn.note}</span>
        </div>
      ) : (
        <MessageActions className={cn("gap-1 text-xs", turn.status === "done" && turn.content && "-ml-1.5")}>
          {turn.content && turn.status === "done" && <CopyAnswer text={turn.content} />}
          <span>{turn.note}</span>
        </MessageActions>
      ))}
    </Message>
  );
});

function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const ctrl = useRef<AbortController | null>(null);
  const running = isRunning(turns[turns.length - 1]);

  const updateLast = (fn: (t: AssistantTurn) => AssistantTurn) =>
    setTurns((ts) => {
      const last = ts[ts.length - 1];
      return last?.role === "assistant" ? [...ts.slice(0, -1), fn(last)] : ts;
    });

  async function send(text?: string) {
    const question = (text ?? input).trim();
    if (!question || running) return;
    const messages = historyFor(turns, question);
    setTurns((ts) => [...ts, { role: "user", content: question }, newAssistantTurn()]);
    setInput("");
    const c = new AbortController();
    ctrl.current = c;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }), signal: c.signal });
      if (res.status === 401) { window.location.assign("/login"); return; }
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        const note = err.error === "chat_busy" ? "Another answer is in progress. Try again when it ends." : err.message ?? `Error ${res.status}`;
        updateLast((t) => ({ ...t, status: "error", note }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = sseFrames(rest + decoder.decode(value, { stream: true }));
        rest = parsed.rest;
        if (parsed.frames.length) updateLast((t) => parsed.frames.reduce(applyEvent, t));
      }
      updateLast((t) => endTurn(t, "ended"));
    } catch {
      updateLast((t) => endTurn(t, c.signal.aborted ? "aborted" : "dropped"));
    } finally {
      if (ctrl.current === c) ctrl.current = null;
    }
  }

  // Stop aborts the fetch; the proxy passes the abort on and cerebro-server kills the run.
  const stop = () => ctrl.current?.abort();
  useEffect(() => () => ctrl.current?.abort(), []);

  return (
    <>
      <ChatContainerRoot className="relative min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]">
        <ChatContainerContent className="mx-auto w-full max-w-3xl gap-8 px-4 pt-6 pb-10">
          {turns.length === 0 ? (
            <div className="flex flex-col items-center gap-5 pt-[12vh] text-center">
              <div className="space-y-2">
                <h2 className="m-0 text-2xl font-semibold tracking-tight">What do you want to know?</h2>
                <p className="m-0 max-w-xl text-muted-foreground">
                  Claude answers from Cerebro's recorded sessions, summaries and project states, and cites client, project, session and date.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <PromptSuggestion key={s} size="sm" className="h-9 px-4 font-normal" onClick={() => void send(s)}>{s}</PromptSuggestion>
                ))}
              </div>
            </div>
          ) : turns.map((t, i) => t.role === "user" ? (
            <Message key={i} className="justify-end">
              <MessageContent className="max-w-[85%] rounded-3xl bg-muted px-5 py-2.5 whitespace-pre-wrap text-foreground sm:max-w-[75%]">
                {t.content}
              </MessageContent>
            </Message>
          ) : <AssistantMessage key={i} turn={t} />)}
        </ChatContainerContent>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <ScrollButton className="pointer-events-auto bg-card shadow-sm" aria-label="Scroll to the newest message" />
        </div>
      </ChatContainerRoot>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
        <PromptInput
          value={input} onValueChange={setInput} onSubmit={() => void send()} isLoading={running}
          className="relative z-10 w-full rounded-3xl border border-input bg-card p-0 pt-1 shadow-xs"
        >
          <PromptInputTextarea
            placeholder="Ask about a client or project…" maxLength={8000} aria-label="Your question"
            className="min-h-[44px] pt-3 pl-4 text-base leading-[1.3] text-foreground dark:bg-transparent"
          />
          <PromptInputActions className="mt-2 flex w-full items-center justify-between gap-2 p-2">
            <div className="flex items-center gap-1">
              {turns.length > 0 && !running && (
                <PromptInputAction tooltip="New chat">
                  <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={() => setTurns([])}>
                    <SquarePen /> New chat
                  </Button>
                </PromptInputAction>
              )}
              <span className="hidden pl-2 text-xs text-muted-foreground sm:inline">Enter to send · Shift+Enter for a new line</span>
            </div>
            <PromptInputAction tooltip={running ? "Stop" : "Send"}>
              {running ? (
                <Button size="icon" variant="secondary" className="size-9 rounded-full" onClick={stop} aria-label="Stop">
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button size="icon" className="size-9 rounded-full" disabled={!input.trim()} onClick={() => void send()} aria-label="Send">
                  <ArrowUp className="size-[18px]" />
                </Button>
              )}
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>
      </div>
    </>
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
