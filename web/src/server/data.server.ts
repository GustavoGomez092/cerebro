// What the pages read, behind a session check. Plain functions (deps injected) so they are tested without a server;
// the server functions in src/lib/api.ts call them with the real auth and cerebro client.
import type { CerebroClient, ChatInput, SearchInput } from "./cerebro.server";

export class Unauthorized extends Error {
  constructor() { super("sign in first"); this.name = "Unauthorized"; }
}

export interface SessionUser { id: string; email: string; name: string }
export type GetSession = (headers: Headers) => Promise<{ user: SessionUser } | null>;

export async function requireUser(headers: Headers, getSession: GetSession): Promise<SessionUser> {
  const s = await getSession(headers);
  if (!s?.user) throw new Unauthorized();
  return s.user;
}

const INCLUDE = new Set(["all", "summaries", "raw"]);
/** Only the fields the dashboard search takes; anything else the browser sent is dropped. */
const searchFields = (b: SearchInput): SearchInput => ({
  query: String(b.query ?? ""),
  ...(typeof b.limit === "number" ? { limit: b.limit } : {}),
  ...(b.include && INCLUDE.has(b.include) ? { include: b.include } : {}),
  ...(typeof b.from === "string" ? { from: b.from } : {}),
  ...(typeof b.to === "string" ? { to: b.to } : {}),
});

export function dashboardData(deps: { getSession: GetSession; cerebro: CerebroClient }) {
  const guarded = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => async (headers: Headers, ...a: A): Promise<T> => {
    await requireUser(headers, deps.getSession);
    return fn(...a);
  };
  return {
    overview: guarded(() => deps.cerebro.overview()),
    db: guarded(() => deps.cerebro.db()),
    clients: guarded(() => deps.cerebro.clients()),
    search: guarded((b: SearchInput) => deps.cerebro.search(searchFields(b))),
    sessionSummaries: guarded((id: string) => deps.cerebro.sessionSummaries(id)),
  };
}

const jsonError = (status: number, error: string, message: string) =>
  Response.json({ error, message }, { status, headers: { "Cache-Control": "no-store" } });

const isConversation = (b: any): b is ChatInput =>
  Array.isArray(b?.messages) && b.messages.length > 0 &&
  b.messages.every((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string");

/** cerebro-server reads at most 64 KB per request and the prompt keeps at most 8 000 chars of a turn. */
const TURN_CHARS = 8000, BODY_BYTES = 56_000, MAX_TURNS = 40;

/** The newest turns that fit the server's body limit, each cut to TURN_CHARS; the question (last) always stays. */
function fitConversation(messages: ChatInput["messages"]): ChatInput["messages"] {
  let kept = messages.slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.content.slice(0, TURN_CHARS) }));
  const size = () => new TextEncoder().encode(JSON.stringify({ messages: kept })).length;
  while (kept.length > 1 && size() > BODY_BYTES) kept = kept.slice(1);
  return kept;
}

/**
 * POST /api/chat: the signed-in owner's chat turn, streamed from cerebro-server's /v1/dashboard/chat. Same-origin
 * only (Origin must be the app's); the browser's disconnect aborts the upstream request, which kills the CLI run.
 */
export async function chatProxy(request: Request, deps: { getSession: GetSession; cerebro: CerebroClient; origin: string }): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!(await deps.getSession(request.headers))?.user) return jsonError(401, "unauthorized", "sign in first");
  if (origin !== null && origin !== deps.origin) return jsonError(403, "forbidden", "cross-origin request");
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, "invalid_json", "body is not valid JSON"); }
  if (!isConversation(body)) return jsonError(400, "invalid_body", "send {messages: [{role, content}…]}");
  let upstream: Response;
  try {
    upstream = await deps.cerebro.chat({ messages: fitConversation(body.messages) }, request.signal);
  } catch {
    return jsonError(502, "unreachable", "cerebro-server is unreachable");
  }
  if (!upstream.ok || !upstream.body) {
    const e = (await upstream.json().catch(() => ({}))) as { error?: string; message?: string };
    return jsonError(upstream.status || 502, e.error ?? "error", e.message ?? "the chat failed");
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

export type DashboardData = ReturnType<typeof dashboardData>;
