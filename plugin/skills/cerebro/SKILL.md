---
name: cerebro
description: Use when Cerebro says this folder is not set up, or when the user wants to change which client/project this folder belongs to, stop recording here, or check Cerebro's status.
---

# Cerebro: set up or change this folder

Cerebro records Claude Code work into a searchable memory, grouped by client and project. Nothing is recorded in a folder until the user opts in. Use only the Cerebro MCP tools named below, with exactly these argument names.

## Setting up a folder that is not set up

1. Call `cerebro_folder`. It shows the folder, its repo and subpath, its current binding, and the existing clients with their projects. Do not start the user's own task before this is settled.
2. If the folder is not bound, ask with AskUserQuestion: "Is this a new project? Do you want to use Cerebro on it?"
3. If the answer is no, call `cerebro_decline` and tell the user Cerebro will not ask again in this folder.
4. If yes, ask these in order, each with AskUserQuestion:
   - Which client? Offer the existing clients as options, plus "Personal" and "New client..." (ask for the name).
   - Which project? Offer that client's existing projects, plus "New project..." (ask for the name) and "No project".
   - Only when `subpath` from `cerebro_folder` is not empty: bind the whole repo, or only this subfolder?
5. Call `cerebro_bind` with `client`, optionally `project`, and `whole_repo` (true for the whole repo, false for only this subfolder; leave it out when subpath is empty).
6. If the result suggests moving earlier sessions, ask the user first, and only then call `cerebro_adopt`.
7. Tell the user that past conversations for this folder, from Claude Code, its subagents, Codex and Gemini CLI, are being imported in the background. Mention that `~/.cerebro/bin/cerebro schedule` keeps new sessions from other agents flowing in, and offer to run it for them.
8. After a successful bind, run `~/.cerebro/bin/cerebro status`; if its `retention:` line shows fewer than 36500 days, ask with AskUserQuestion whether to raise how long Claude Code keeps its transcripts, so older history survives until Cerebro has imported it (Claude Code deletes transcripts after that many days; 30 by default). If they agree, run `~/.cerebro/bin/cerebro retention`.
9. Build an initial project history, after a successful bind only, so Cerebro knows how the project got here:
   - If the folder is not a git repo (or `git log` fails), skip `git log` and work from the docs alone. Otherwise run `git log --since="12 months ago" --date=short --pretty='%ad %s' | head -400` in the folder.
   - Read the README and the main docs briefly (for example `README*`, `CHANGELOG*`, `docs/`). Never read or open secrets files while doing this: `.env` and `.env.*`, `*.pem`, `*.key`, `id_rsa`-style keys, `credentials*`, `secrets*`, or anything that looks like it holds passwords or tokens.
   - Write at most 1500 words of plain prose covering: what the project is, how it got here, key decisions with dates, current state, open questions. Only what the log and docs show; no guesses, and no secrets even if you saw one.
   - Call `cerebro_save_history` with `title` (for example "<project>: history to <today>"), `text`, `from` (the oldest date the history covers, such as the first `git log` date) and `to` (today), both as YYYY-MM-DD.
   - Tell the user the project history is saved in Cerebro. If the call says the folder is not bound or is declined, tell the user that instead and do not retry.

## Changing an existing binding or declining a bound folder

When `cerebro_folder` shows the folder is already bound (or declined) and the user wants something different:

1. Show the current binding next to the new one.
2. Get explicit confirmation from the user.
3. Only then call `cerebro_bind` (or `cerebro_decline`) again with `rebind: true`.

If a call fails with a conflict error saying the folder is already bound differently, that is the same situation: do not retry with `rebind: true` until the user has confirmed the change.

## Checking status

For "is Cerebro working?", run `~/.cerebro/bin/cerebro status` (add `--retry` to clear a block and upload once). Its `retention:` line is how long Claude Code keeps transcripts; `~/.cerebro/bin/cerebro retention` raises it (only with the user's agreement).
