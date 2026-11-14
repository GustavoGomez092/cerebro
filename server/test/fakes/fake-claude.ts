export {};
// Stand-in for the `claude` CLI. Run as: SUMMARISER_CMD="bun server/test/fakes/fake-claude.ts"
// Mode comes from FAKE_CLAUDE_MODE: ok (default) | structured | echo | limit | auth | garbage | notjson | slow
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const stdin = await Bun.stdin.text();
const argv = process.argv.slice(2);

const envelope = (over: Record<string, unknown>) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  duration_ms: 1,
  num_turns: 1,
  result: "",
  stop_reason: "end_turn",
  session_id: "fake-session",
  total_cost_usd: 0,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: Number(process.env.FAKE_CLAUDE_CACHE_CREATION ?? 7),
    cache_read_input_tokens: 3,
  },
  modelUsage: { "claude-haiku-fake": {} },
  credential_expires_at: "2030-01-01T00:00:00.000Z",
  ...over,
});

const failure = (text: string) =>
  envelope({ subtype: "error", is_error: true, result: text, usage: undefined, modelUsage: undefined });

const summaryFor = (prompt: string) => ({ summary: `fake summary: ${prompt.trim()}` });
const emit = (obj: unknown) => console.log(JSON.stringify(obj));

switch (mode) {
  case "ok":
    emit(envelope({ result: JSON.stringify(summaryFor(stdin)) }));
    break;
  case "structured":
    emit(envelope({ result: "", structured_output: summaryFor(stdin) }));
    break;
  case "echo":
    emit(
      envelope({
        result: JSON.stringify({
          argv,
          stdin,
          headless: process.env.CEREBRO_HEADLESS,
          apiKey: process.env.ANTHROPIC_API_KEY,
          authToken: process.env.ANTHROPIC_AUTH_TOKEN,
          baseUrl: process.env.ANTHROPIC_BASE_URL,
          configDir: process.env.CLAUDE_CONFIG_DIR,
        }),
      }),
    );
    break;
  case "status401":
    emit({ ...failure("Something unrelated went wrong"), api_error_status: 401 });
    process.exit(1);
  case "hitlimit":
    emit(failure("You've hit your limit · resets 3pm (America/Chicago)"));
    process.exit(1);
  case "limitreached":
    emit(failure("5-hour limit reached"));
    process.exit(1);
  case "limit":
    emit(failure(`Claude AI usage limit reached|${process.env.FAKE_CLAUDE_RESET_EPOCH ?? "1900000000"}`));
    process.exit(1);
  case "auth":
    emit(failure("Invalid API key - Please run /login"));
    process.exit(1);
  case "garbage":
    console.log("this is not json {{{");
    break;
  case "notjson":
    emit(envelope({ result: "Sorry, here is prose instead of JSON." }));
    break;
  case "slow":
    await new Promise((r) => setTimeout(r, 60_000));
    emit(envelope({ result: JSON.stringify(summaryFor(stdin)) }));
    break;
  default:
    console.error(`unknown FAKE_CLAUDE_MODE ${mode}`);
    process.exit(2);
}
