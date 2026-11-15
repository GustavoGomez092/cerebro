// Headless Claude Code runner: one `claude -p` call per summary, prompt on stdin.
import { estimateTokens } from "./budget";

/**
 * - unavailable: the CLI or the API is not working right now (CLI missing or not starting, a crash with no
 *   output, a connection error, a 5xx/529 "overloaded" response): an outage, not the job's fault.
 * - failed: any other error.
 */
export type ClaudeFailureKind = "usage_limit" | "auth" | "timeout" | "bad_output" | "unavailable" | "failed";

export type ClaudeRun =
  | { ok: true; output: unknown; tokens: number; model: string; credentialExpiresAt: string | null }
  | {
      ok: false;
      kind: ClaudeFailureKind;
      message: string;
      resetAt: Date | null;
      /**
       * What a call that reached the model spent before it failed (I2): the usage its envelope reported, or,
       * when it reported none, an estimate from the input for a clean exit with unusable output or an unknown
       * error envelope. Absent when nothing reached the model (CLI missing or crashed, outage, login, limit)
       * and for a timeout, whose caller charges its own estimate.
       */
      tokens?: number;
    };

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

/** Tokens an envelope's usage reports (input + output + cache creation), or null when it has no usage. */
function usageTokens(env: Record<string, unknown>): number | null {
  const u = env.usage;
  if (!u || typeof u !== "object") return null;
  const usage = u as Record<string, unknown>;
  return num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_input_tokens);
}

/** A failure that spent `tokens` (omitted when 0). */
const charged = (r: ClaudeRun, tokens: number): ClaudeRun => (!r.ok && tokens > 0 ? { ...r, tokens } : r);

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

/** The CLI to run (SUMMARISER_CMD, default `claude`), split into words. The chat agent uses the same one. */
export const claudeCommand = (env: Record<string, string | undefined>): string[] =>
  (env.SUMMARISER_CMD ?? "claude").trim().split(/\s+/).filter(Boolean);

/** Variables that would make the CLI bill an API account instead of the owner's subscription login. */
export const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;

/**
 * The environment for a `claude -p` child: subscription login only (API-key variables removed) and
 * CEREBRO_HEADLESS=1, so a Cerebro client installed alongside never records the call.
 */
export function subscriptionEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...env, CEREBRO_HEADLESS: "1" };
  for (const k of API_KEY_VARS) delete childEnv[k];
  return childEnv;
}

export { classify as classifyClaudeError };

export async function runClaude(input: ClaudeInput, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeRun> {
  const cmd = claudeCommand(env);
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
  const childEnv = subscriptionEnv(env);

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
    /** What a call that reached the model but reported no usage is assumed to have spent. */
    const estimate = estimateTokens(input.systemPrompt.length + input.prompt.length);
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
      // A clean exit with output we cannot read: the model very likely ran, so it is charged an estimate.
      return charged(fail("bad_output", `claude stdout was not a JSON object: ${out.slice(0, 200)}`), estimate);
    }

    const used = usageTokens(parsed);
    if (parsed.is_error !== false) {
      const text = typeof parsed.result === "string" ? parsed.result : err || `claude error (exit ${code})`;
      const r = classify(text, parsed.api_error_status);
      // An unknown error after an answer envelope (e.g. structured-output retries ran out) may have spent a lot;
      // a login, limit or outage error never reached the model, so only reported usage counts for those.
      return charged(r, used ?? (!r.ok && r.kind === "failed" ? estimate : 0));
    }

    const structured = parseStructured(parsed);
    if (!structured) return charged(fail("bad_output", "claude result was not valid JSON for the schema"), used ?? estimate);

    const tokens = used ?? 0;
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
