import type {
  Binding, Client, EventView, IngestBatch, IngestResult, Project, SearchRequest, SearchResponse, SessionView,
} from "@cerebro/shared";
import type { ClientConfig } from "./config";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CallOpts { timeoutMs?: number }

export interface StatusResponse {
  machine: string;
  queue: { pending: number; dead: number; oldestPendingSeconds: number };
  embedder: { lastSuccessAt: string | null; lastError: string | null; pausedUntil: string | null };
  dbBytes: number;
}

export interface ScopeQuery {
  repo?: string;
  subpath?: string;
  scope?: "open";
  clientId?: string;
  projectId?: string;
}
export interface SessionsQuery extends ScopeQuery { from?: string; to?: string; limit?: number; before?: string }
export interface EventsQuery extends ScopeQuery { afterSeq?: number; limit?: number; full?: boolean }
export interface BindingInput {
  repo: string;
  subpath: string;
  status: "active" | "declined";
  clientId?: string | null;
  projectId?: string | null;
  rebind?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class ApiClient {
  constructor(private cfg: ClientConfig, private fetchFn: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, opts: { body?: unknown; query?: object; auth?: boolean } & CallOpts = {}): Promise<T> {
    const url = new URL(this.cfg.serverUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {};
    if (opts.auth !== false) headers.Authorization = `Bearer ${this.cfg.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new ApiError(0, "timeout", `request to ${path} timed out`);
      throw new ApiError(0, "network", `request to ${path} failed: ${(e as Error)?.message ?? e}`);
    }
    const text = await res.text().catch(() => "");
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!res.ok) {
      throw new ApiError(res.status, typeof json?.error === "string" ? json.error : "http_error", json?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  health(o: CallOpts = {}) {
    // /health answers 503 with a body when the DB is down; surface that as ok:false rather than an error.
    return this.call<{ ok: boolean; instanceId: string | null; apiVersion: number }>("GET", "/health", { auth: false, ...o })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 503) return { ok: false, instanceId: null, apiVersion: 0 };
        throw e;
      });
  }
  status(o: CallOpts = {}) { return this.call<StatusResponse>("GET", "/v1/status", o); }
  resolve(repo: string, subpath: string, o: CallOpts = {}) {
    return this.call<{ binding: Binding | null }>("GET", "/v1/bindings/resolve", { query: { repo, subpath }, ...o });
  }
  putBinding(b: BindingInput, o: CallOpts = {}) { return this.call<{ binding: Binding }>("PUT", "/v1/bindings", { body: b, ...o }); }
  listClients(o: CallOpts = {}) { return this.call<{ clients: Client[] }>("GET", "/v1/clients", o); }
  createClient(name: string, o: CallOpts = {}) { return this.call<Client>("POST", "/v1/clients", { body: { name }, ...o }); }
  listProjects(clientId: string, o: CallOpts = {}) {
    return this.call<{ projects: Project[] }>("GET", `/v1/clients/${encodeURIComponent(clientId)}/projects`, o);
  }
  createProject(clientId: string, name: string, o: CallOpts = {}) {
    return this.call<Project>("POST", "/v1/projects", { body: { clientId, name }, ...o });
  }
  adopt(bindingId: string, o: CallOpts = {}) {
    return this.call<{ moved: number }>("POST", `/v1/bindings/${encodeURIComponent(bindingId)}/adopt`, o);
  }
  ingest(batch: IngestBatch, o: CallOpts = {}) { return this.call<IngestResult>("POST", "/v1/ingest", { body: batch, ...o }); }
  endSession(id: string, endedAt: string, o: CallOpts = {}) {
    return this.call<{ ok: boolean }>("POST", `/v1/sessions/${encodeURIComponent(id)}/end`, { body: { endedAt }, ...o });
  }
  search(req: SearchRequest, o: CallOpts = {}) { return this.call<SearchResponse>("POST", "/v1/search", { body: req, ...o }); }
  sessions(q: SessionsQuery = {}, o: CallOpts = {}) {
    return this.call<{ sessions: SessionView[]; next: string | null }>("GET", "/v1/sessions", { query: q, ...o });
  }
  events(sessionId: string, q: EventsQuery = {}, o: CallOpts = {}) {
    const { full, ...rest } = q;
    return this.call<{ events: EventView[]; nextSeq: number | null }>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      query: { ...rest, ...(full ? { full: "1" } : {}) }, ...o,
    });
  }
}
