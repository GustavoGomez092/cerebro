// Server functions: each runs on the web server, checks the Better Auth session, then calls cerebro-server with the
// web-ui token (src/server/*.server.ts, imported inside the handlers so none of it reaches the browser bundle).
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import type { DashboardData } from "../server/data.server";

/** The data call, with a missing session turned into a redirect to the login page. Server-only (stubbed in the browser). */
const guarded = createServerOnlyFn(async <T,>(fn: (data: DashboardData, headers: Headers) => Promise<T>): Promise<T> => {
  const { appDeps } = await import("../server/deps.server");
  const { Unauthorized } = await import("../server/data.server");
  try {
    return await fn(appDeps().data, getRequest().headers);
  } catch (e) {
    if (e instanceof Unauthorized) throw redirect({ to: "/login" });
    throw e;
  }
});

/** The signed-in owner, or null. */
export const getMe = createServerFn({ method: "GET" }).handler(async () => {
  const { appDeps } = await import("../server/deps.server");
  const s = await appDeps().getSession(getRequest().headers);
  return s ? { email: s.user.email, name: s.user.name } : null;
});

export const getOverview = createServerFn({ method: "GET" }).handler(() => guarded((d, h) => d.overview(h)));
export const getDbStats = createServerFn({ method: "GET" }).handler(() => guarded((d, h) => d.db(h)));
export const getClients = createServerFn({ method: "GET" }).handler(() => guarded((d, h) => d.clients(h)));

export const searchAll = createServerFn({ method: "POST" })
  .validator((input: { query: string; include?: "all" | "summaries" | "raw" }) => {
    const query = String(input?.query ?? "").trim().slice(0, 2000);
    if (!query) throw new Error("type something to search for");
    const include = input?.include === "summaries" || input?.include === "raw" ? input.include : "all";
    return { query, include, limit: 30 } as const;
  })
  .handler(({ data }) => guarded((d, h) => d.search(h, data)));

export const getSessionSummaries = createServerFn({ method: "GET" })
  .validator((id: string) => {
    if (typeof id !== "string" || !id || id.length > 200) throw new Error("bad session id");
    return id;
  })
  .handler(({ data }) => guarded((d, h) => d.sessionSummaries(h, data)));
