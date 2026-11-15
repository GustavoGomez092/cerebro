// Production server for the built app (vite build → dist/): static assets from dist/client, everything else through
// TanStack Start's handler. Run with `bun web/server.ts` (the cerebro-web container does).
import { join, normalize, sep } from "node:path";

type Handler = { fetch: (req: Request) => Response | Promise<Response> };

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

/** The request handler: hashed assets (cached for good), then the app with security headers on every answer. */
export function webFetch(handler: Handler, clientDir: string) {
  const root = normalize(clientDir) + sep;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const path = normalize(join(root, decodeURIComponent(url.pathname)));
      if (path.startsWith(root)) {
        const file = Bun.file(path);
        if (await file.exists()) return new Response(file, { headers: { "Cache-Control": "public, max-age=31536000, immutable", ...SECURITY_HEADERS } });
      }
    }
    const res = await handler.fetch(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

if (import.meta.main) {
  const dist = join(import.meta.dir, "dist");
  const handler = (await import(join(dist, "server", "server.js"))).default as Handler;
  const port = Number(process.env.PORT ?? 3000);
  // idleTimeout: a chat stream carries a ping every 8 s, so 30 s never cuts a live answer.
  const server = Bun.serve({ port, hostname: process.env.HOST ?? "0.0.0.0", idleTimeout: 30, fetch: webFetch(handler, join(dist, "client")) });
  console.log(JSON.stringify({ level: "info", msg: "cerebro-web listening", port: server.port }));
}
