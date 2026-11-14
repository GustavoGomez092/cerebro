// Headless Claude Code runner: one `claude -p` call per summary, prompt on stdin.
export type ClaudeFailureKind = "usage_limit" | "auth" | "timeout" | "bad_output" | "failed";

export type ClaudeRun =
  | { ok: true; output: unknown; tokens: number; model: string; credentialExpiresAt: string | null }
  | { ok: false; kind: ClaudeFailureKind; message: string; resetAt: Date | null };

export interface ClaudeInput {
  systemPrompt: string;
  prompt: string;
  schema: object;
  timeoutMs?: number;
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

function classify(text: string, status?: unknown): ClaudeRun {
  const message = text.trim().slice(0, 500) || "claude failed";
  if (/usage limit|rate limit|hit your limit|limit reached/i.test(text)) {
    return fail("usage_limit", message, parseResetAt(text));
  }
  if (status === 401 || status === 403 || /login|auth|credential|401/i.test(text)) return fail("auth", message);
  return fail("failed", message);
}

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

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: childEnv });
  } catch (e) {
    return fail("failed", `cannot start ${cmd[0]}: ${(e as Error).message}`);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
    if (timedOut) return fail("timeout", `claude timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);

    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(out);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      /* handled below */
    }

    if (!parsed) {
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
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}
