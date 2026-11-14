import type { SQL } from "bun";
import { freshDb } from "../../server/test/helpers";
import { createApp } from "../../server/src/http/app";
import { createToken } from "../../server/src/auth";
import { fakeEmbedder } from "../../server/src/embed/fake";
import { ApiClient } from "../src/api";

export const TEST_URL = "http://cerebro.test";

export interface LiveServer {
  api: ApiClient;
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
  const api = new ApiClient({ serverUrl: TEST_URL, token }, fetchFn);
  return { api, fetch: fetchFn, sql: db.sql, instanceId: instance_id, token, drop: db.drop };
}
