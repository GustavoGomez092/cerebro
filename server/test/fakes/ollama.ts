/** A stand-in Ollama on a random port (Bun.serve, port 0): /api/tags and /api/embed. Never the real one. */
export type OllamaMode = "ok" | "503" | "400" | "hang" | "dims768" | "slow";
export const DIGEST = "790764642607" + "b".repeat(52);
/** The text the router's prober embeds to check an endpoint. */
const CANARY = "cerebro embedder health check";

/** Vectors are 1024 dims filled with `fill`, so a test can tell which Ollama answered. */
export function fakeOllama(fill: number, dims = 1024) {
  const s = {
    mode: "ok" as OllamaMode,
    models: [{ name: "bge-m3:latest", digest: DIGEST }] as { name: string; digest: string }[],
    /** Embed calls and their inputs, not counting the prober's canary (counted in canaryCalls). */
    embedCalls: 0, canaryCalls: 0, tagCalls: 0, aborted: 0,
    /** "slow": answers after this long (a cold model load), unless the request is aborted first. */
    delayMs: 300,
    inputs: [] as string[][],
    keepAlive: [] as unknown[],
    started: Promise.withResolvers<void>(),
  };
  const server = Bun.serve({
    // Bind loopback explicitly: a wildcard bind can share a port number with a process bound to 127.0.0.1
    // (e.g. a local Ollama runner), which then answers this fake's URL instead (seen as a 404 flake).
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/tags") { s.tagCalls++; return Response.json({ models: s.models }); }
      if (path !== "/api/embed") return new Response("no", { status: 404 });
      const body = (await req.json()) as { input: string[]; keep_alive?: unknown };
      if (body.input.length === 1 && body.input[0] === CANARY) s.canaryCalls++;
      else { s.embedCalls++; s.inputs.push(body.input); }
      s.keepAlive.push(body.keep_alive);
      s.started.resolve();
      if (s.mode === "hang") {
        await new Promise((r) => req.signal.addEventListener("abort", () => { s.aborted++; r(null); }));
        return new Response("", { status: 500 });
      }
      if (s.mode === "slow") {
        const aborted = await new Promise<boolean>((r) => {
          setTimeout(() => r(false), s.delayMs);
          req.signal.addEventListener("abort", () => { s.aborted++; r(true); });
        });
        if (aborted) return new Response("", { status: 500 });
      }
      if (s.mode === "503") return new Response("busy", { status: 503 });
      if (s.mode === "400") return new Response("bad input", { status: 400 });
      const n = s.mode === "dims768" ? 768 : dims;
      return Response.json({ embeddings: body.input.map(() => new Array(n).fill(fill)) });
    },
  });
  return Object.assign(s, { url: `http://127.0.0.1:${server.port}`, server, stop: () => server.stop(true) });
}
