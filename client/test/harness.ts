import type { SQL } from "bun";
import { freshDb } from "../../server/test/helpers";
import { createApp } from "../../server/src/http/app";
import { createToken } from "../../server/src/auth";
import { fakeEmbedder } from "../../server/src/embed/fake";
import { ApiClient, verificationRecord, VERIFIED_KEY, type StateReader } from "../src/api";

export const TEST_URL = "http://cerebro.test";

/** State that always reads as freshly verified: for setup clients and tests that are not about the instance check. */
export function trustedState(serverUrl = TEST_URL): StateReader {
  return { get: (k) => (k === "instanceId" ? "trusted" : k === VERIFIED_KEY ? verificationRecord(serverUrl, "trusted") : undefined) };
}

export interface LiveServer {
  /** Talks to the server without any instance check (test setup). */
  api: ApiClient;
  /** A client gated by `state` (a Store), as the plugin builds it: the token goes out only after that store's instance check. */
  clientFor(state: StateReader, fetchFn?: typeof fetch): ApiClient;
  fetch: typeof fetch;
  sql: SQL;
  instanceId: string;
  token: string;
  drop(): Promise<void>;
}

/** Runs the real server app in-process against a throwaway database; `fetch` routes http://cerebro.test/* to it. */
export async function liveServer(): Promise<LiveServer> {
  const db = await freshDb();
  const { token } = await createToken(db.sql, "test-mac");
  const app = createApp({ sql: db.sql, embedder: fakeEmbedder(), log: () => {} });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.origin !== TEST_URL) throw new TypeError(`unrouted host ${u.origin}`);
    return app.request(req);
  }) as typeof fetch;
  const [{ instance_id }] = await db.sql`select instance_id from settings`;
  const api = new ApiClient({ serverUrl: TEST_URL, token }, trustedState(), fetchFn);
  const clientFor = (state: StateReader, f: typeof fetch = fetchFn) => new ApiClient({ serverUrl: TEST_URL, token }, state, f);
  return { api, clientFor, fetch: fetchFn, sql: db.sql, instanceId: instance_id, token, drop: db.drop };
}
