import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding } from "@cerebro/shared";
import { captureTranscript, sweepOpenCursors } from "../src/capture";
import type { FolderIdentity } from "../src/identity";
import { Store } from "../src/store";

let prev: string | undefined;
const dirs: string[] = [];
beforeAll(() => { prev = process.env.CEREBRO_HOME; });
afterAll(() => {
  if (prev === undefined) delete process.env.CEREBRO_HOME; else process.env.CEREBRO_HOME = prev;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cerebro-capture-"));
  dirs.push(d);
  return d;
}
const SID = "11111111-2222-4333-a444-555555555555";
const ident: FolderIdentity = { repo: "github.com/acme/app", subpath: "", root: "/work/app", isGit: true };
const binding = (status: "active" | "declined" = "active"): Binding =>
  ({ id: "b1", repo: ident.repo, subpath: "", status, clientId: null, projectId: null });

function setup() {
  process.env.CEREBRO_HOME = tmp();
  const store = new Store();
  const path = join(tmp(), `${SID}.jsonl`);
  return { store, path, input: { sessionId: SID, transcriptPath: path, cwd: "/work/app" } };
}
let n = 0;
function line(type: "user" | "assistant", content: unknown, entrypoint = "cli"): string {
  n++;
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type, timestamp: `2026-10-20T04:13:${String(10 + n).padStart(2, "0")}.000Z`,
    entrypoint, userType: "external", version: "2.1.304", gitBranch: "main", uuid: `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`,
    sessionId: SID, cwd: "/work/app", message: { role: type, content },
  }) + "\n";
}

test("records only bound folders and only new complete lines", () => {
  const { store, path, input } = setup();
  store.cacheBinding(ident.repo, "", binding());
  const l3 = line("user", "third");
  writeFileSync(path, line("user", "first") + line("assistant", "second") + l3.slice(0, 30));
  const r1 = captureTranscript(store, input, ident);
  expect(r1).toEqual({ status: "recorded", events: 2, skipped: 0 });
  expect(store.pendingCount()).toBe(2);
  const sess = store.unsentSessions(10)[0];
  expect(sess).toMatchObject({ id: SID, bindingId: "b1", cwd: "/work/app", repo: ident.repo, subpath: "", imported: false });
  expect(sess.meta?.agent).toBe("claude-code");
  appendFileSync(path, l3.slice(30));
  const r2 = captureTranscript(store, input, ident);
  expect(r2.events).toBe(1);
  expect(store.pendingCount()).toBe(3);
  expect(store.unsentSessions(10)[0].startedAt).toBe(sess.startedAt);
  expect(store.unsentSessions(10)[0].meta?.gitBranch).toBe("main");
  store.close();
});

test("declined, unbound and headless sessions queue nothing", () => {
  const { store, path, input } = setup();
  writeFileSync(path, line("user", "hi"));
  expect(captureTranscript(store, input, ident).status).toBe("not_bound");
  store.cacheBinding(ident.repo, "", null);
  expect(captureTranscript(store, input, ident).status).toBe("not_bound");
  store.cacheBinding(ident.repo, "", binding("declined"));
  expect(captureTranscript(store, input, ident).status).toBe("declined");
  store.cacheBinding(ident.repo, "", binding());
  expect(captureTranscript(store, input, ident, { env: { CEREBRO_HEADLESS: "1" } }).status).toBe("headless");
  expect(store.pendingCount()).toBe(0);
  expect(store.unsentSessions(10)).toEqual([]);

  const sdk = setup();
  sdk.store.cacheBinding(ident.repo, "", binding());
  writeFileSync(sdk.path, line("user", "hi", "sdk-ts"));
  expect(captureTranscript(sdk.store, sdk.input, ident).status).toBe("headless");
  appendFileSync(sdk.path, line("assistant", "later"));
  expect(captureTranscript(sdk.store, sdk.input, ident).status).toBe("headless");
  expect(sdk.store.pendingCount()).toBe(0);
  expect(sdk.store.unsentSessions(10)).toEqual([]);
  expect(sdk.store.openCursors()).toEqual([]);
  store.close(); sdk.store.close();
});

test("a missing transcript reports missing", () => {
  const { store, input } = setup();
  store.cacheBinding(ident.repo, "", binding());
  expect(captureTranscript(store, input, ident)).toEqual({ status: "missing", events: 0, skipped: 0 });
  store.close();
});

test("opting in later captures the whole session from the start", () => {
  const { store, path, input } = setup();
  writeFileSync(path, line("user", "a") + line("assistant", "b"));
  expect(captureTranscript(store, input, ident).status).toBe("not_bound");
  expect(store.pendingCount()).toBe(0);
  store.cacheBinding(ident.repo, "", binding());
  expect(captureTranscript(store, input, ident)).toMatchObject({ status: "recorded", events: 2 });
  store.close();
});

test("tool names survive across captures", () => {
  const { store, path, input } = setup();
  store.cacheBinding(ident.repo, "", binding());
  writeFileSync(path, line("assistant", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]));
  captureTranscript(store, input, ident);
  appendFileSync(path, line("user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]));
  captureTranscript(store, input, ident);
  const res = store.nextEvents(10, 1e9).find((e) => e.kind === "tool_result");
  expect(res?.toolName).toBe("Bash");
  store.close();
});

test("sweep picks up lines written after the last hook", () => {
  const { store, path, input } = setup();
  store.cacheBinding(ident.repo, "", binding());
  writeFileSync(path, line("user", "a"));
  captureTranscript(store, input, ident);
  appendFileSync(path, line("assistant", "final"));
  expect(sweepOpenCursors(store)).toBe(1);
  expect(store.pendingCount()).toBe(2);
  expect(sweepOpenCursors(store)).toBe(0);
  store.close();
});
