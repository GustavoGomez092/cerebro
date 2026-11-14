/** A stand-in Ollama on a random port (Bun.serve, port 0): /api/tags and /api/embed. Never the real one. */
export type OllamaMode = "ok" | "503" | "400" | "hang" | "dims768";
export const DIGEST = "790764642607" + "b".repeat(52);

/** Vectors are 1024 dims filled with `fill`, so a test can tell which Ollama answered. */
export function fakeOllama(fill: number, dims = 1024) {
  const s = {
    mode: "ok" as OllamaMode,
    models: [{ name: "bge-m3:latest", digest: DIGEST }] as { name: string; digest: string }[],
    embedCalls: 0, tagCalls: 0, aborted: 0,
    inputs: [] as string[][],
    started: Promise.withResolvers<void>(),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/tags") { s.tagCalls++; return Response.json({ models: s.models }); }
      if (path !== "/api/embed") return new Response("no", { status: 404 });
      s.embedCalls++;
      const body = (await req.json()) as { input: string[] };
      s.inputs.push(body.input);
      s.started.resolve();
      if (s.mode === "hang") {
        await new Promise((r) => req.signal.addEventListener("abort", () => { s.aborted++; r(null); }));
        return new Response("", { status: 500 });
      }
      if (s.mode === "503") return new Response("busy", { status: 503 });
      if (s.mode === "400") return new Response("bad input", { status: 400 });
      const n = s.mode === "dims768" ? 768 : dims;
      return Response.json({ embeddings: body.input.map(() => new Array(n).fill(fill)) });
    },
  });
  return Object.assign(s, { url: `http://127.0.0.1:${server.port}`, server, stop: () => server.stop(true) });
}
