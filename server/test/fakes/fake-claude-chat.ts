export {};
// Stand-in for `claude -p --output-format stream-json` in chat runs. The chat passes the CLI an allowlisted
// environment, so the fake takes its options as extra words of SUMMARISER_CMD, before the CLI's own arguments:
//   SUMMARISER_CMD="bun server/test/fakes/fake-claude-chat.ts --fake-mode=slow --fake-pidfile=/tmp/x"
// --fake-mode:
//   ok (default): init; a real MCP call (initialize, tools/call global_search with the question) to the --mcp-config
//                 server; the tool_use and tool_result messages; text deltas; the final assistant message; a result
//   echo:         one assistant text holding {argv, stdin, cwd, env, the mcp config file and its mode}; a result
//   limit:        init, then a usage-limit error result (exit 1)
//   auth:         a login error result (exit 1)
//   maxturns:     init, then an error_max_turns result (exit 1)
//   noinit:       assistant text and a result, with no init message first
//   slow:         init, then 60 s of silence
//   crash:        exit 3 with no output
// --fake-pidfile=<path>: the fake writes its pid there first.
// --fake-init-tools=<a,b>: the tool list the init message reports (default: the --allowedTools list, as the real CLI
//   2.1.311 reports for the chat's arguments). --fake-mcp-status=<status>: the cerebro server's status (default connected).
import { readFileSync, statSync, writeFileSync } from "node:fs";

const all = process.argv.slice(2);
const opt = (name: string) => all.find((a) => a.startsWith(`--fake-${name}=`))?.slice(`--fake-${name}=`.length);
const argv = all.filter((a) => !a.startsWith("--fake-"));
const mode = opt("mode") ?? "ok";
if (opt("pidfile")) writeFileSync(opt("pidfile")!, String(process.pid));
const stdin = await Bun.stdin.text();
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const emit = (o: unknown) => console.log(JSON.stringify(o));
const initTools = opt("init-tools")?.split(",").filter(Boolean) ?? (arg("--allowedTools") ?? "").split(",").filter(Boolean);
const init = () => emit({
  type: "system", subtype: "init", session_id: "fake-chat", model: "claude-sonnet-fake", tools: initTools,
  mcp_servers: [{ name: "cerebro", status: opt("mcp-status") ?? "connected" }],
});
const result = (over: Record<string, unknown> = {}) => emit({
  type: "result", subtype: "success", is_error: false, result: "", session_id: "fake-chat", num_turns: 2,
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 999 },
  modelUsage: { "claude-sonnet-fake": {} }, ...over,
});
const question = stdin.trim().split("\n").pop() ?? "";

switch (mode) {
  case "ok": {
    init();
    const cfg = JSON.parse(readFileSync(arg("--mcp-config")!, "utf8")).mcpServers.cerebro;
    const rpc = async (body: object) => {
      const res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json", ...cfg.headers }, body: JSON.stringify(body) });
      return res.status === 202 ? null : res.json();
    };
    await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } });
    const input = { query: question };
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "mcp__cerebro__global_search", input }] } });
    const r: any = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "global_search", arguments: input } });
    const hits = JSON.parse(r.result.content[0].text).hits;
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: r.result.content }] } });
    const parts = ["Found ", `${hits.length} hit(s)`, hits[0] ? ` in ${hits[0].client}` : "", "."];
    for (const p of parts) emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } } });
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: parts.join("") }] } });
    result({ result: parts.join("") });
    break;
  }
  case "echo": {
    const cfgPath = arg("--mcp-config");
    const text = JSON.stringify({
      argv, stdin, cwd: process.cwd(), env: { ...process.env },
      mcpConfig: cfgPath ? JSON.parse(readFileSync(cfgPath, "utf8")) : null,
      mcpConfigMode: cfgPath ? (statSync(cfgPath).mode & 0o777).toString(8) : null,
      mcpConfigPath: cfgPath,
    });
    init();
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    result({ result: text });
    break;
  }
  case "limit":
    init();
    emit({ type: "result", subtype: "error", is_error: true, result: "Claude AI usage limit reached|1900000000", session_id: "fake-chat" });
    process.exit(1);
  case "auth":
    emit({ type: "result", subtype: "error", is_error: true, result: "Invalid API key - Please run /login", session_id: "fake-chat" });
    process.exit(1);
  case "maxturns":
    init();
    emit({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "fake-chat", num_turns: 13,
      usage: { input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 0 } });
    process.exit(1);
  case "noinit":
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "leaked before init" }] } });
    result({ result: "leaked before init" });
    break;
  case "slow":
    init();
    await Bun.sleep(60_000);
    result();
    break;
  case "crash":
    process.exit(3);
  default:
    console.error(`unknown --fake-mode ${mode}`);
    process.exit(2);
}
