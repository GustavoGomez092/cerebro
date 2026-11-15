// cerebro-server's dashboard API, called from the web server only. The web-ui token lives in this closure: it is
// never returned, logged, put in an error or serialised.

export class CerebroError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CerebroError";
  }
}

export interface SearchInput { query: string; limit?: number; include?: "all" | "summaries" | "raw"; from?: string; to?: string }
export interface ChatInput { messages: { role: "user" | "assistant"; content: string }[] }

export function cerebroClient(o: { baseUrl: string; token: string; fetch?: typeof fetch }) {
  const base = o.baseUrl.replace(/\/+$/, "");
  const fetchFn = o.fetch ?? fetch;
  const send = (method: string, path: string, body?: unknown, signal?: AbortSignal) =>
    fetchFn(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${o.token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await send(method, path, body);
    } catch {
      throw new CerebroError(502, "unreachable", "cerebro-server is unreachable");
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new CerebroError(res.status, e.error ?? "error", e.message ?? `cerebro-server answered ${res.status}`);
    }
    return (await res.json()) as T;
  };
  return {
    overview: () => json<any>("GET", "/v1/dashboard/overview"),
    db: () => json<any>("GET", "/v1/dashboard/db"),
    clients: () => json<any>("GET", "/v1/dashboard/clients"),
    search: (b: SearchInput) => json<any>("POST", "/v1/dashboard/search", b),
    sessionSummaries: (id: string) => json<any>("GET", `/v1/dashboard/sessions/${encodeURIComponent(id)}/summaries`),
    /** The chat's event stream (or cerebro-server's JSON refusal), cancelled with `signal`. */
    chat: (b: ChatInput, signal?: AbortSignal) => send("POST", "/v1/dashboard/chat", b, signal),
    toJSON: () => ({ baseUrl: base }),
  };
}
export type CerebroClient = ReturnType<typeof cerebroClient>;
