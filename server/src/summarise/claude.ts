// Headless Claude Code runner: one `claude -p` call per summary, prompt on stdin.
/**
 * - unavailable: the CLI or the API is not working right now (CLI missing or not starting, a crash with no
 *   output, a connection error, a 5xx/529 "overloaded" response): an outage, not the job's fault.
 * - failed: any other error.
 */
export type ClaudeFailureKind = "usage_limit" | "auth" | "timeout" | "bad_output" | "unavailable" | "failed";

export type ClaudeRun =
  | { ok: true; output: unknown; tokens: number; model: string; credentialExpiresAt: string | null }
  | { ok: false; kind: ClaudeFailureKind; message: string; resetAt: Date | null };

export interface ClaudeInput {
  systemPrompt: string;
  prompt: string;
  schema: object;
  timeoutMs?: number;
  /** Aborting kills the call; it then fails like a timeout (a killed call, its spend unknown). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 180_000;

const fail = (kind: ClaudeFailureKind, message: string, resetAt: Date | null = null): ClaudeRun => ({
  ok: false,
  kind,
  message,
  resetAt,
});

function parseResetAt(text: string): Date | null {
  const epoch = text.match(/\|\s*(\d{9,13})\b/);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n > 1e11 ? n : n * 1000);
  }
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/);
  if (iso) {
    const d = new Date(iso[0]);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Connection and server-side errors: the API is unreachable or overloaded, whatever the input. */
const OUTAGE_TEXT =
  /connection error|connection refused|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|overloaded|service unavailable|bad gateway|gateway time-?out|internal server error|API Error: 5\d\d\b/i;

function classify(text: string, status?: unknown): ClaudeRun {
  const message = text.trim().slice(0, 500) || "claude failed";
  if (/usage limit|rate limit|hit your limit|limit reached/i.test(text)) {
    return fail("usage_limit", message, parseResetAt(text));
  }
  if (status === 401 || status === 403) return fail("auth", message);
  if (typeof status === "number" && status >= 500) return fail("unavailable", message);
  if (OUTAGE_TEXT.test(text)) return fail("unavailable", message);
  if (/login|auth|credential|401/i.test(text)) return fail("auth", message);
  return fail("failed", message);
}

/**
 * A tiny known-good call. When a call fails, this tells an outage (the probe fails too) from a failure
 * the job caused (the probe works); it also tells when an expired login or an outage is over.
 */
export const HEALTH_PROBE: ClaudeInput = {
  systemPrompt: 'Reply with the JSON object {"ok": true} and nothing else.',
  prompt: "ping",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  timeoutMs: 60_000,
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseStructured(env: Record<string, unknown>): { value: unknown } | null {
  if (env.structured_output != null && typeof env.structured_output === "object") {
    return { value: env.structured_output };
  }
  if (typeof env.result !== "string") return null;
  const text = env.result.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

export async function runClaude(input: ClaudeInput, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeRun> {
  const cmd = (env.SUMMARISER_CMD ?? "claude").trim().split(/\s+/).filter(Boolean);
  const args = [
    ...cmd,
    "-p",
    "--model", "haiku",
    "--output-format", "json",
    "--json-schema", JSON.stringify(input.schema),
    "--system-prompt", input.systemPrompt,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  // Subscription login only: an API key in the env would make the CLI bill the API instead.
  const childEnv: Record<string, string | undefined> = { ...env, CEREBRO_HEADLESS: "1" };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete childEnv[k];

  if (input.signal?.aborted) return fail("timeout", "claude call aborted");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: childEnv });
  } catch (e) {
    return fail("unavailable", `cannot start ${cmd[0]}: ${(e as Error).message}`);
  }

  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => {
    aborted = true;
    proc.kill("SIGKILL");
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const stdout = new Response(proc.stdout as ReadableStream).text();
    const stderr = new Response(proc.stderr as ReadableStream).text();
    try {
      const sink = proc.stdin as import("bun").FileSink;
      sink.write(input.prompt);
      await sink.end();
    } catch {
      // child may exit before reading stdin; its output still tells us why
    }
    const [out, err, code] = await Promise.all([stdout, stderr, proc.exited]);
    if (aborted) return fail("timeout", "claude call aborted");
    if (timedOut) return fail("timeout", `claude timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);

    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(out);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      /* handled below */
    }

    if (!parsed) {
      // 127: the shell found no such command. No output at all: the CLI died before it could say why.
      if (code === 127 || (code !== 0 && !`${err}${out}`.trim())) {
        return fail("unavailable", `${err}\n${out}`.trim().slice(0, 500) || `claude exited with code ${code} and no output`);
      }
      if (code !== 0) return classify(`${err}\n${out}`.trim() ||`claude exited with code ${code}`);
      return fail("bad_output", `claude stdout was not a JSON object: ${out.slice(0, 200)}`);
    }

    if (parsed.is_error !== false) {
      const text = typeof parsed.result === "string" ? parsed.result : err || `claude error (exit ${code})`;
      return classify(text, parsed.api_error_status);
    }

    const structured = parseStructured(parsed);
    if (!structured) return fail("bad_output", "claude result was not valid JSON for the schema");

    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    const tokens = num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_input_tokens);
    const model = Object.keys((parsed.modelUsage ?? {}) as object)[0] ?? "unknown";
    const exp = parsed.credential_expires_at;
    return {
      ok: true,
      output: structured.value,
      tokens,
      model,
      credentialExpiresAt: typeof exp === "string" ? exp : null,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}
