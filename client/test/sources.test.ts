import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding } from "@cerebro/shared";
import { captureTranscript } from "../src/capture";
import { claudeSubagentsSource } from "../src/sources/claude-subagents";
import { codexSource } from "../src/sources/codex";
import { geminiSource } from "../src/sources/gemini";
import { addToInbox, genericSource } from "../src/sources/generic";
import { allSources, sourceById, sourceFor } from "../src/sources";
import type { HistorySource, SourceFile } from "../src/sources/types";
import { Store } from "../src/store";
import { fileIdentity, syncAllSources } from "../src/sync";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const dirs: string[] = [];
let prevHome: string | undefined;
beforeAll(() => { prevHome = process.env.CEREBRO_HOME; });
afterAll(() => {
  if (prevHome === undefined) delete process.env.CEREBRO_HOME; else process.env.CEREBRO_HOME = prevHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cerebro-sources-")));
  dirs.push(d);
  return d;
};
const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); return path; };
const start = { offset: 0, line: 0 };
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

function newStore(): Store {
  const d = tmp();
  process.env.CEREBRO_HOME = d;
  return new Store(join(d, "cerebro.db"));
}
const binding = (id = crypto.randomUUID()): Binding =>
  ({ id, repo: "r", subpath: "", status: "active", clientId: null, projectId: null }) as unknown as Binding;

// --- Codex ---------------------------------------------------------------------------------------

const CODEX_ID = "00000000-0000-4000-8000-000000000001";
function codexHome(text = fixture("codex-rollout.jsonl")) {
  const home = tmp();
  const path = write(join(home, ".codex", "sessions", "2026", "01", "05", `rollout-2026-01-05T10-00-07-${CODEX_ID}.jsonl`), text);
  return { home, path };
}

test("codex rollout → user/assistant/tool events, repo identity from the git url, codex: session id", async () => {
  const { home, path } = codexHome();
  write(join(home, ".codex", "sessions", "2026", "01", "05", "notes.txt"), "not a rollout\n");
  const files = await codexSource.discover({ home });
  expect(files).toHaveLength(1);
  const file = files[0]!;
  expect(file).toMatchObject({
    source: "codex", path, sessionId: `codex:${CODEX_ID}`, cwd: "/Users/dev/projects/demo",
    repo: "https://github.com/example/demo.git",
  });
  expect(fileIdentity(file.cwd!, file.repo ?? null, "mac").repo).toBe("github.com/example/demo");

  const r = codexSource.read(file, start);
  const kinds = r.events.map((e) => e.kind);
  for (const k of ["user", "assistant", "tool_call", "tool_result"]) expect(kinds).toContain(k as never);
  expect(r.events.every((e) => e.sessionId === `codex:${CODEX_ID}`)).toBe(true);
  // developer messages and event_msg / turn_context / ghost_snapshot lines are skipped and counted
  expect(r.events.some((e) => e.text.includes("developer"))).toBe(false);
  expect(r.skipped).toBe(8);
  expect(r.events).toHaveLength(10);

  const calls = r.events.filter((e) => e.kind === "tool_call");
  const results = r.events.filter((e) => e.kind === "tool_result");
  expect(calls.map((e) => e.toolName)).toEqual(["shell", "update_plan", "apply_patch"]);
  expect(results.map((e) => e.toolName)).toEqual(["shell", "update_plan", "apply_patch"]);
  expect(calls[0]!.toolInput).toEqual({ command: ["placeholder command 11", "placeholder command 12"], workdir: "placeholder workdir 13" });
  expect(calls[2]!.toolInput).toBe("placeholder input 17");

  const reasoning = r.events.find((e) => e.meta?.reasoning !== undefined)!;
  expect(reasoning).toMatchObject({ kind: "assistant", text: "", meta: { reasoning: "placeholder text 10" } });
  expect(r.events.find((e) => e.kind === "assistant" && e.text)!.text).toBe("placeholder text 20");

  for (const e of r.events) {
    const [line, block] = e.key.split(":").map(Number);
    expect(e.seq).toBe(line! * 16 + block!);
  }
  expect(r.firstTimestamp).toBe("2026-01-05T10:00:07.000Z");
  expect(r.cwd).toBe("/Users/dev/projects/demo");
  expect(r.headless).toBe(false);
  expect(r.sessionMeta).toMatchObject({ originator: "codex_cli_rs", cliVersion: "0.58.0", gitBranch: "main" });
});

test("codex: a growing rollout yields only the new lines; scripted runs are headless", async () => {
  const { home, path } = codexHome();
  const [file] = await codexSource.discover({ home });
  const first = codexSource.read(file!, start);
  appendFileSync(path, JSON.stringify({ timestamp: "2026-01-05T11:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "one more" }] } }) + "\n");
  const next = codexSource.read(file!, { offset: first.nextOffset, line: first.nextLine, state: first.state });
  expect(next.events.map((e) => e.text)).toEqual(["one more"]);
  expect(next.events[0]!.key).toBe("19:0");

  const exec = fixture("codex-rollout.jsonl").replace('"originator":"codex_cli_rs"', '"originator":"codex_sdk_ts"').replace('"source":"cli"', '"source":"exec"');
  const scripted = codexHome(exec);
  const [f2] = await codexSource.discover({ home: scripted.home });
  expect(codexSource.read(f2!, start).headless).toBe(true);
});

// --- Claude Code subagents -----------------------------------------------------------------------

const PARENT = "11111111-1111-4111-8111-111111111111";
function subagentHome(opts: { subagentCwd?: boolean; parent?: boolean } = {}) {
  const home = tmp();
  const project = join(home, ".claude", "projects", "-Users-dev-projects-demo");
  if (opts.parent !== false) {
    write(join(project, `${PARENT}.jsonl`), [
      JSON.stringify({ type: "file-history-snapshot", messageId: "m", snapshot: {} }),
      JSON.stringify({ type: "user", uuid: "22222222-2222-4222-8222-222222222222", timestamp: "2026-01-05T09:59:00.000Z", cwd: "/Users/dev/parent-cwd", sessionId: PARENT, message: { role: "user", content: "hi" } }),
    ].join("\n") + "\n");
  }
  let text = fixture("subagent.jsonl");
  if (opts.subagentCwd === false) text = text.replace(/"cwd":"[^"]*",/g, "");
  const path = write(join(project, PARENT, "subagents", "agent-a0b1c2d3e4f5a6b7c.jsonl"), text);
  write(join(project, PARENT, "subagents", "agent-a0b1c2d3e4f5a6b7c.meta.json"), JSON.stringify({ agentType: "Explore", description: "placeholder" }));
  return { home, path };
}

test("subagent transcripts become their own session linked to the parent", async () => {
  const { home, path } = subagentHome();
  const files = await claudeSubagentsSource.discover({ home });
  expect(files).toHaveLength(1);
  const file = files[0]!;
  const sid = `${PARENT}/agent-a0b1c2d3e4f5a6b7c`;
  expect(file).toMatchObject({ source: "claude-code-subagent", path, sessionId: sid, cwd: "/Users/dev/projects/demo" });

  const r = claudeSubagentsSource.read(file, start);
  expect(r.sessionMeta).toMatchObject({ parentSessionId: PARENT, agentType: "Explore" });
  expect(r.cwd).toBe("/Users/dev/projects/demo");
  expect(r.events.length).toBeGreaterThan(5);
  expect(r.events.every((e) => e.sessionId === sid)).toBe(true);
  expect(new Set(r.events.map((e) => e.kind))).toEqual(new Set(["user", "assistant", "tool_call", "tool_result"]));
  expect(r.skipped).toBe(2); // the attachment lines

  // captured, the session row names the subagent source
  const store = newStore();
  store.cacheBinding("github.com/example/demo", "", binding());
  const c = captureTranscript(store, { sessionId: sid, transcriptPath: path, cwd: r.cwd!, source: claudeSubagentsSource },
    { repo: "github.com/example/demo", subpath: "", root: r.cwd!, isGit: true });
  expect(c.status).toBe("recorded");
  expect(store.unsentSessions(10)[0]!.meta).toMatchObject({ agent: "claude-code-subagent", parentSessionId: PARENT, agentType: "Explore" });
  store.close();
});

test("subagent without a cwd takes the parent transcript's", async () => {
  const { home } = subagentHome({ subagentCwd: false });
  const [file] = await claudeSubagentsSource.discover({ home });
  expect(file!.cwd).toBe("/Users/dev/parent-cwd");
  expect(claudeSubagentsSource.read(file!, start).cwd).toBe("/Users/dev/parent-cwd");

  const orphan = subagentHome({ subagentCwd: false, parent: false });
  const [f2] = await claudeSubagentsSource.discover({ home: orphan.home });
  expect(f2!.cwd).toBeNull();
  expect(claudeSubagentsSource.read(f2!, start).cwd).toBeNull();
});

// --- Gemini CLI ----------------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const G1 = "00000000-0000-4000-8000-000000000001";
const G2 = "00000000-0000-4000-8000-000000000002";

test("gemini logs map to the project whose sha256 path matches, prompts only, cursor by record count", async () => {
  const home = tmp();
  const project = tmp();
  const records = JSON.parse(fixture("gemini-logs.json")) as Record<string, unknown>[];
  records.push({ sessionId: G2, messageId: 3, type: "gemini", message: "a model turn", timestamp: "2026-01-05T10:00:30.000Z" });
  const logs = write(join(home, ".gemini", "tmp", sha(project), "logs.json"), JSON.stringify(records));
  write(join(home, ".gemini", "tmp", sha("/somewhere/else"), "logs.json"), fixture("gemini-logs.json"));

  expect(await geminiSource.discover({ home })).toEqual([]); // no known folders, nothing matches
  const files = await geminiSource.discover({ home, folders: [project, "/not/a/project"] });
  expect(files.map((f) => f.sessionId).sort()).toEqual([`gemini:${G1}`, `gemini:${G2}`]);
  for (const f of files) expect(f).toMatchObject({ source: "gemini-cli", cwd: project });
  expect(files.every((f) => sourceFor(f.path) === geminiSource)).toBe(true);

  const f2 = files.find((f) => f.sessionId === `gemini:${G2}`)!;
  const r = geminiSource.read(f2, start);
  expect(r.events.map((e) => [e.kind, e.key, e.text])).toEqual([
    ["user", "0", "placeholder message 2"], ["user", "1", "placeholder message 3"], ["user", "2", "placeholder message 4"],
  ]);
  expect(r.events.every((e) => e.sessionId === `gemini:${G2}`)).toBe(true);
  expect(r.skipped).toBe(1);
  expect(r.nextOffset).toBe(5); // records of the file consumed, not bytes
  expect(r.firstTimestamp).toBe("2026-01-05T10:00:14.000Z");

  // the file is rewritten in place with one more prompt
  records.push({ sessionId: G2, messageId: 4, type: "user", message: "next prompt", timestamp: "2026-01-05T10:01:00.000Z" });
  writeFileSync(logs, JSON.stringify(records, null, 2));
  const next = geminiSource.read(f2, { offset: r.nextOffset, line: r.nextLine });
  expect(next.events.map((e) => e.text)).toEqual(["next prompt"]);
  expect(next.nextOffset).toBe(6);
});

// --- generic cerebro-jsonl -----------------------------------------------------------------------

test("generic cerebro-jsonl files import; malformed lines are skipped and counted; finished files move to done/", async () => {
  const home = tmp();
  const inbox = join(home, ".cerebro", "inbox");
  const path = write(join(inbox, "export.jsonl"), fixture("generic.jsonl") + "{not json\n" + JSON.stringify({ type: "event", key: "e9", kind: "user", text: "no ts" }) + "\n");
  write(join(inbox, "bad-header.jsonl"), JSON.stringify({ type: "event", key: "x" }) + "\n");
  write(join(inbox, "notes.txt"), "ignored\n");

  const files = await genericSource.discover({ home });
  expect(files).toHaveLength(1);
  const file = files[0]!;
  expect(file).toMatchObject({ source: "generic", path, sessionId: "my-agent:run-0001", cwd: "/Users/dev/projects/demo", repo: "https://github.com/example/demo.git" });
  expect(sourceFor(path)).toBe(genericSource);

  const r = genericSource.read(file, start);
  expect(r.events.map((e) => e.key)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  expect(r.events[2]).toMatchObject({ kind: "tool_call", toolName: "read_file", toolInput: { path: "placeholder/path.txt" }, meta: { callId: "c1" } });
  expect(r.skipped).toBe(2);
  expect(r.sessionMeta).toMatchObject({ agent: "my-agent", model: "example-model-1" });
  expect(r.firstTimestamp).toBe("2026-01-05T10:00:00.000Z");

  // synced into a bound folder: the session is named after the file's agent and the file moves to done/
  const store = newStore();
  store.cacheBinding("github.com/example/demo", "", binding());
  const out = await syncAllSources(store, null, "mac", { home, sources: [genericSource] });
  expect(out.bySource.generic).toMatchObject({ files: 1, events: 5 });
  expect(store.unsentSessions(10)[0]).toMatchObject({ id: "my-agent:run-0001", imported: true, meta: { agent: "my-agent" } });
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(inbox, "done", "export.jsonl"))).toBe(true);
  expect(existsSync(join(inbox, "bad-header.jsonl"))).toBe(true);
  store.close();
});

test("import-file validates the format and copies the file into the inbox", () => {
  const home = tmp();
  const src = write(join(tmp(), "hermes.jsonl"), fixture("generic.jsonl").replace('"agent":"my-agent",', ""));
  expect(() => addToInbox(src, { home })).toThrow(/agent/);
  const added = addToInbox(src, { home, agent: "hermes" });
  expect(added).toMatchObject({ events: 5, skipped: 0 });
  expect(added.path.startsWith(join(home, ".cerebro", "inbox"))).toBe(true);
  expect(JSON.parse(readFileSync(added.path, "utf8").split("\n")[0]!)).toMatchObject({ type: "session", agent: "hermes", id: "run-0001" });
  // a second copy of the same name does not overwrite the first
  expect(addToInbox(src, { home, agent: "hermes" }).path).not.toBe(added.path);

  const notJsonl = write(join(tmp(), "x.jsonl"), "hello\n");
  expect(() => addToInbox(notJsonl, { home })).toThrow();
});

// --- every adapter -------------------------------------------------------------------------------

test("every adapter redacts secrets and never throws on drift", async () => {
  const garbage = "{\"broken\": \n";
  const cases: { source: HistorySource; file: () => Promise<SourceFile> }[] = [
    {
      source: codexSource,
      file: async () => {
        const meta = fixture("codex-rollout.jsonl").split("\n")[0]!.replace('"branch":"main"', `"branch":"fix-${SECRET}"`);
        const { home } = codexHome([
          meta,
          garbage.trim(),
          JSON.stringify({ timestamp: "2026-01-05T10:00:10.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `key ${SECRET}` }] } }),
          JSON.stringify({ timestamp: "2026-01-05T10:00:11.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["echo", SECRET] }), call_id: "c1" } }),
          JSON.stringify({ timestamp: "2026-01-05T10:00:12.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: SECRET } }),
          JSON.stringify({ timestamp: "2026-01-05T10:00:13.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: SECRET }] } }),
          JSON.stringify({ timestamp: "2026-01-05T10:00:14.000Z", type: "response_item", payload: "drifted" }),
        ].join("\n") + "\n");
        return (await codexSource.discover({ home }))[0]!;
      },
    },
    {
      source: claudeSubagentsSource,
      file: async () => {
        const { home, path } = subagentHome();
        appendFileSync(path, garbage + JSON.stringify({ type: "user", uuid: "33333333-3333-4333-8333-333333333333", timestamp: "2026-01-05T10:05:00.000Z", message: { role: "user", content: `key ${SECRET}` } }) + "\n");
        return (await claudeSubagentsSource.discover({ home }))[0]!;
      },
    },
    {
      source: geminiSource,
      file: async () => {
        const home = tmp();
        const project = tmp();
        write(join(home, ".gemini", "tmp", sha(project), "logs.json"), JSON.stringify([
          "garbage", null, { sessionId: G1, messageId: 0, type: "user", message: `key ${SECRET}`, timestamp: "2026-01-05T10:00:00.000Z" },
          { sessionId: G1, messageId: 1, type: "user", message: 42, timestamp: "nope" },
        ]));
        return (await geminiSource.discover({ home, folders: [project] }))[0]!;
      },
    },
    {
      source: genericSource,
      file: async () => {
        const home = tmp();
        write(join(home, ".cerebro", "inbox", "s.jsonl"), [
          JSON.stringify({ type: "session", agent: "my-agent", id: "r1", cwd: "/w", startedAt: "2026-01-05T10:00:00.000Z", meta: { note: SECRET } }),
          garbage.trim(),
          JSON.stringify({ type: "event", key: "k1", ts: "2026-01-05T10:00:01.000Z", kind: "user", text: `key ${SECRET}` }),
          JSON.stringify({ type: "event", key: "k2", ts: "2026-01-05T10:00:02.000Z", kind: "tool_call", text: "", toolName: "sh", toolInput: { cmd: SECRET }, meta: { m: SECRET } }),
          JSON.stringify({ type: "event", key: "k3", ts: "2026-01-05T10:00:03.000Z", kind: "nonsense", text: "x" }),
        ].join("\n") + "\n");
        return (await genericSource.discover({ home }))[0]!;
      },
    },
  ];
  for (const c of cases) {
    const file = await c.file();
    expect(file).toBeDefined();
    const r = c.source.read(file, start);
    const dump = JSON.stringify({ events: r.events, meta: r.sessionMeta });
    expect(r.events.length, c.source.id).toBeGreaterThan(0);
    expect(dump, c.source.id).not.toContain("sk-ant-");
    expect(dump, c.source.id).toContain("[REDACTED:anthropic-key]");
    expect(r.skipped, c.source.id).toBeGreaterThan(0);
    // a missing file never throws either
    expect(() => c.source.read({ ...file, path: file.path + ".gone" }, start)).not.toThrow();
  }
});

test("the registry lists every adapter in order and finds the owner of a path", () => {
  expect(allSources().map((s) => s.id)).toEqual(["claude-code", "claude-code-subagent", "codex", "gemini-cli", "generic"]);
  expect(allSources().filter((s) => s.live).map((s) => s.id)).toEqual(["claude-code"]);
  expect(sourceFor("/h/.claude/projects/-x/abc.jsonl")?.id).toBe("claude-code");
  expect(sourceFor("/h/.claude/projects/-x/abc/subagents/agent-1.jsonl")?.id).toBe("claude-code-subagent");
  expect(sourceFor("/h/.codex/sessions/2026/01/05/rollout-x.jsonl")?.id).toBe("codex");
  expect(sourceFor("/h/.gemini/tmp/abc/logs.json")?.id).toBe("gemini-cli");
  expect(sourceFor("/h/.cerebro/inbox/x.jsonl")?.id).toBe("generic");
  expect(sourceFor("/h/elsewhere.jsonl")).toBeNull();
  for (const s of allSources()) expect(sourceById(s.id)).toBe(s);
  expect(sourceById("nope")).toBeNull();
});
