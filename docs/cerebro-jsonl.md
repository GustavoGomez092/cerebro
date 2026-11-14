# cerebro-jsonl v1: handing any agent's history to Cerebro

Cerebro reads Claude Code, Claude Code subagents, Codex CLI and Gemini CLI history by itself. Any other
agent or script (Hermes, Paperclip, a cron job, a home-grown tool) hands its history over as a
**cerebro-jsonl v1** file. Either:

- write the file into `~/.cerebro/inbox/` (name it `*.jsonl`), or
- run `cerebro import-file <path> [--agent <name>]`, which checks the file, copies it into the inbox and syncs.

`cerebro sync` (at Claude Code session start when the last sync is over an hour old, and every 30 minutes
once `cerebro schedule` is installed) records the file the same way as every other agent's history:

- only when its folder (`cwd`, or `repo` when given) is opted in to Cerebro; files of other folders stay in
  the inbox untouched and are picked up if the folder is opted in later;
- secrets are stripped on the Mac before anything is uploaded;
- the session's `meta.agent` is the file's `agent`;
- once every line has been read the file moves to `~/.cerebro/inbox/done/`.

Write the file under another name and rename it to `*.jsonl` when it is complete (sync only reads lines that
end in a newline, and moves the file once the last one is read).

## Format

UTF-8, one JSON object per line, every line ending in `\n`.

**Line 1: the session.**

| field       | required | meaning |
|-------------|----------|---------|
| `type`      | yes      | `"session"` |
| `agent`     | yes\*    | the agent's name: letters, digits, `.`, `_`, `-`, at most 64 characters (\*`import-file --agent` supplies or replaces it) |
| `id`        | yes      | the agent's own id for this session (at most 120 characters); the Cerebro session id is `<agent>:<id>` |
| `cwd`       | yes      | absolute path of the folder the session worked in; decides which project the history belongs to |
| `repo`      | no       | the folder's git remote (any spelling: `https://…`, `git@host:owner/repo.git`); used as the folder identity when the folder is not a clone of it on this Mac |
| `startedAt` | yes      | ISO 8601 time the session started |
| `meta`      | no       | object of extra session facts (model, version…) |

**Every other line: one event.**

| field       | required | meaning |
|-------------|----------|---------|
| `type`      | yes      | `"event"` |
| `key`       | yes      | unique within the session (at most 500 characters); writing the same key again is ignored, so re-exports are safe |
| `ts`        | yes      | ISO 8601 time of the event |
| `kind`      | yes      | `user`, `assistant`, `tool_call` or `tool_result` |
| `text`      | yes      | the message text (`""` for a tool call) |
| `toolName`  | no       | for `tool_call` / `tool_result` (at most 200 characters) |
| `toolInput` | no       | any JSON, for `tool_call` |
| `meta`      | no       | object of extra event facts |

Lines that do not follow the format (bad JSON, missing fields, unknown `kind`) are skipped and counted; the
rest of the file is still recorded. A file whose first line is not a valid session is left in the inbox;
`cerebro import-file` on it prints what is wrong.

## Example

```jsonl
{"type":"session","agent":"hermes","id":"run-0001","cwd":"/Users/me/projects/shop","repo":"https://github.com/acme/shop.git","startedAt":"2026-11-13T09:00:00.000Z","meta":{"model":"example-model-1"}}
{"type":"event","key":"e1","ts":"2026-11-13T09:00:01.000Z","kind":"user","text":"Why does checkout fail for EU customers?"}
{"type":"event","key":"e2","ts":"2026-11-13T09:00:04.000Z","kind":"tool_call","text":"","toolName":"read_file","toolInput":{"path":"src/checkout.ts"}}
{"type":"event","key":"e3","ts":"2026-11-13T09:00:05.000Z","kind":"tool_result","text":"export function vat(country) { … }","toolName":"read_file"}
{"type":"event","key":"e4","ts":"2026-11-13T09:00:09.000Z","kind":"assistant","text":"The VAT lookup has no entry for IE, so the total is NaN."}
```

## Example exporter (TypeScript)

```ts
import { renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Msg = { role: "user" | "assistant"; text: string; at: Date };
export function exportToCerebro(agent: string, id: string, cwd: string, messages: Msg[]): void {
  const lines = [{ type: "session", agent, id, cwd, startedAt: (messages[0]?.at ?? new Date()).toISOString() },
    ...messages.map((m, i) => ({ type: "event", key: `m${i}`, ts: m.at.toISOString(), kind: m.role, text: m.text }))];
  const path = join(homedir(), ".cerebro", "inbox", `${agent}-${id}.jsonl`);
  writeFileSync(path + ".partial", lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  renameSync(path + ".partial", path); // sync only ever sees the complete file
}
```

(Create `~/.cerebro/inbox/` first if it does not exist.)
