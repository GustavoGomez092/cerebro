# Cerebro — design

Date: 2026-11-13
Status: approved by owner 2026-11-13

## Intent

Cerebro is a long-lived memory for the owner's Claude Code sessions across every
machine in the house. Today each Claude Code session starts blank and forgets
everything when it ends. Cerebro records conversations as they happen, distills
them into dated summaries, and lets any later session — on any machine, days or
months later — find out "what's going on in this project" and recall old
details exactly.

The owner works for several clients (plus personal work), each with one or more
projects. Memory is organised that way: **client → project (optional) → data**.

Prior art: [claude-mem](https://github.com/thedotmack/claude-mem) (hooks +
observer agent that compresses activity + SQLite/Chroma + progressive-disclosure
search tools). Cerebro borrows its ideas but is a central, multi-machine service
backed by Postgres.

## Goals

1. **Record automatically.** Once a folder is opted in, every Claude Code
   session there is captured with no further action.
2. **Keep both raw and distilled.** Raw conversations are kept forever, word for
   word. Distilled summaries (decisions, changes, open threads) carry a date/time
   range. Summaries locate *when* something happened; the raw conversation for
   that range is quoted for exact details.
3. **Recall from anywhere.** A session on any machine can get the current state
   of its project and search the past, without the original session being alive.
4. **Organise by client → project.** Every memory belongs to a client
   ("Personal" is a client); the project level is optional.
5. **Opt in per project.** A skill asks at the start of work in an unknown folder
   whether to use Cerebro, and for which client/project.
6. **Expose a query API** that other tools can consume.
7. **Catch up on existing projects.** Most of the time Cerebro is introduced to a
   project that already exists. On opt-in it imports that project's past Claude
   Code conversations and builds an initial project history, so memory is useful
   from the first session rather than starting empty. (Owner's decision.)

## Non-goals

- Recording or serving Hermes, Paperclip, or any non–Claude Code agent. The owner
  explicitly does not want them integrated. (They may use the API later, but
  nothing is built for them.)
- Access from outside the house network. Cerebro is LAN-only like the other
  home-lab services; if Tailscale is added later it should work without changes.
- A web UI. Not requested; the API is the interface. (Builder may add a minimal
  status page if it's nearly free.)
- Multi-user within one install. One owner, several machines. *(Claude's call:
  other people may run Cerebro too, so nothing is hard-coded to this house —
  server URL, network, and deploy target are configuration; each person runs
  their own install. The Zima deployment is one concrete target.)*

## Anti-goals (failure even if it "works")

- **Client leakage.** One client's details surfacing in another client's project
  work.
- **Secrets at rest.** API keys, passwords, tokens stored in Cerebro.
- **Lost memory.** Conversations silently dropped because the laptop was away
  from home, asleep, or the server was down.
- **Slowing Claude Code down.** Hooks must never noticeably delay a prompt or a
  response, and must never break a session when Cerebro is unreachable.
- **Endangering existing services.** Cerebro must not risk the JSLab production
  database or other Zima services.

## Constraints and environment

- **Server:** Zima home server (`ssh zima`, 192.168.4.61, ZimaOS, Ryzen 5 2400GE,
  16 GB RAM, no GPU). Persistent storage under `/DATA`. Services are Docker
  containers registered as ZimaOS apps, named `<name>.home.lab` via the Caddy
  container (`HomeLab/proxy`, plain HTTP on :80). Conventions for this server
  (deploy scripts, secrets handling, app registration, backups) are documented in
  the owner's `operating-zima-home-server` skill and the `HomeLab/*` repos — follow
  them.
- **Clients:** the owner's Macs on the house network (this Mac, plus other Macs
  such as the work MacBook Pro, which also leaves the house). Claude Code is the
  only agent recorded.
- **Summaries use the owner's Claude subscription, not an API key.** (Owner's
  decision.)
- **No new paid services.** Embeddings run locally.

## Approaches considered

1. **Fork claude-mem and retarget it to Postgres on Zima.** Gets working hooks,
   observer and search tools for free, but claude-mem is designed around one
   machine with local SQLite + Chroma throughout; making it central,
   multi-machine and client→project means fighting its design and carrying its
   telemetry and upstream churn.
2. **Build Cerebro fresh, borrowing claude-mem's ideas.** — **Chosen by the
   owner.** A central service on Zima plus a thin client plugin on each Mac.
3. **No service — hooks write straight into Postgres.** Smallest, but the owner
   wants an API and summarisation must run on Zima anyway, so it only delays
   option 2.

Database sub-choice:

- **Dedicated Postgres container for Cerebro** — **Chosen by the owner.**
  Raw-forever storage will grow large; index builds/migrations must not share a
  container with JSLab production; Cerebro needs its own backup policy (30 daily
  full dumps of a growing DB would fill the 256 GB backup drive).
- Reusing the existing `postgres` container by switching it to the pgvector image —
  rejected: restarts JSLab's DB and couples Cerebro's growth to it.

## Decided design

### Components

1. **Cerebro service** (Zima, Docker, ZimaOS app, `http://cerebro.home.lab`)
   - HTTP API (ingest, search, read, bindings, health).
   - Summariser worker.
   - Local embedding model (CPU).
   - TypeScript on Bun. *(Claude's call, accepted with option 2: matches
     claude-mem and the owner's JSLab stack.)*
2. **Cerebro Postgres** — its own container with pgvector, on a private Docker
   network shared only with the Cerebro service; no published port.
3. **Cerebro client plugin** (each Mac) — a Claude Code plugin bundling: the hooks,
   the local offline queue, secret stripping, the opt-in skill, and Cerebro
   search tools for Claude. The hook runner is compiled to a single executable
   (`bun build --compile`) so other Macs need nothing pre-installed. Installed
   once per machine.

### Data model (shape, not final schema)

- **client** — name; "Personal" exists by default.
- **project** — belongs to a client; optional.
- **binding** — maps a folder identity to (client, project?) or to "declined".
  Folder identity = normalised git remote URL of the repo root when there is one
  (so the same repo on any machine resolves to the same binding); otherwise the
  absolute folder path on that specific machine.
  - **Subfolder bindings (owner's decision):** a binding may target a subfolder
    of a repo (repo identity + relative path), so a monorepo can hold work for
    several projects or clients. The most specific binding wins for the folder
    Claude Code was started in.
  - **Re-binding moves history** *(Claude's call)*: changing a folder's
    client/project moves its past sessions, summaries and search chunks to the
    new scope, so a wrong first choice never leaves data under the wrong client.
    Store scope so this is a supported, cheap operation.
  - **Identity changes** *(Claude's call)*: if a repo's remote changes (rename,
    transfer), the folder looks unknown; the opt-in skill offers to link it to
    an existing project, which re-points the binding.
- **project state** — one rolling "current state" document per project (and per
  client for client-only work): what the project is, recent decisions, open
  threads, what's resolved. The summariser updates it after each new summary,
  closing threads that later sessions (on any machine) resolved. *(Claude's
  call: the session-start brief is built from this, so it never shows stale
  open threads.)*
- **session** — one Claude Code session: id, machine, folder, client, project,
  start/end times.
- **raw event / message** — every transcript entry, after secret stripping, in
  order, with timestamps. Kept forever.
- **summary** — distilled record for a span of a session: covers a start/end
  time range, lists decisions, changes, open threads; embedded for search.
- **chunks for search** — embeddings + full-text over conversation text
  (user prompts, assistant replies, tool names and arguments). Large tool
  *outputs* (e.g. full file contents Claude read) are stored in the raw record
  but **not** summarised or embedded. *(Claude's call.)*

### Opt-in flow

1. A `SessionStart` hook asks Cerebro for the binding of the current folder.
2. **Unknown folder:** the hook injects context telling Claude to run the Cerebro
   skill, which asks the owner: *"Is this a new project? Do you want to use
   Cerebro on it?"*
   - **Yes:** ask which client (existing list, "Personal", or a new one), then
     which project (existing, new, or none), and whether to bind the whole repo
     or just this subfolder. Save the binding. Recording starts, then the
     catch-up below runs.
   - **No:** save a "declined" binding; never ask again for that folder (the
     owner can opt in later by invoking the skill manually).
3. **Known folder:** record silently and inject the brief (below).
4. The skill can also be invoked manually to change a folder's client/project.

### Catch-up for existing projects (owner's decision)

When a folder is opted in:

1. **Import past conversations.** The plugin finds this machine's existing Claude
   Code transcripts for the bound folder (and its subfolders, respecting more
   specific bindings) under `~/.claude/projects`, strips secrets, and uploads
   them through the normal queue as historical sessions with their original
   timestamps. Every other Mac does the same for that folder the next time
   Claude Code runs there, since the binding is shared. Imports are idempotent
   by session id, so nothing is duplicated.
2. **Build an initial project history.** In the opt-in session, Claude (via the
   skill) reads the project itself — git history, README/docs, structure — and
   writes an initial history: what the project is, how it got here, key
   decisions visible in the record, and the current state. This seeds the
   project state document and is stored as a summary dated to the period it
   covers.
3. Raw imported conversations are searchable (full-text + vector) as soon as
   they're uploaded and embedded; their summaries are produced over time within
   the summariser budget below.

**Retention:** Claude Code deletes local transcripts after ~30 days by default.
The plugin install raises `cleanupPeriodDays` on each Mac (with the owner's
consent) so history isn't lost before it's imported. *(Claude's call.)*

### Capture

- Hooks send each new piece of the conversation to Cerebro: the owner's prompts,
  Claude's replies, and which tools ran on what (and the raw tool outputs, for
  the raw record). The builder chooses the exact hook events and mechanism (e.g.
  reading new lines of the session transcript file on `Stop`/`SessionEnd`/
  `PreCompact` vs. per-event capture), as long as the whole conversation is
  captured once, in order.
- **Secret stripping happens on the Mac, before anything leaves the machine.**
  Known key formats, `KEY=value` lines for secret-looking names, private keys,
  bearer tokens, connection strings with passwords, etc. are replaced with a
  marker that preserves the fact a secret was there.
- **Offline queue:** every hook writes to a local on-disk queue first and returns
  immediately; a background flush uploads to Cerebro when reachable (retries
  with backoff, idempotent so replays never duplicate). Works across the work
  MacBook Pro leaving and returning home, sleeping, or Zima being down.
- Hooks must never block or fail a Claude Code session.
- **Which sessions are recorded** *(Claude's call)*: interactive Claude Code
  sessions on the Macs (terminal, IDE, desktop app — anything that runs the
  plugin's hooks). Headless `claude -p` runs and scripted/SDK runs are not
  recorded — in particular Cerebro's own summariser must never record itself.
- **Recall doesn't become new memory** *(Claude's call)*: results returned by
  Cerebro's own tools are kept in the raw record but excluded from summaries and
  embeddings. Otherwise content recalled from client B in a session under client
  A would be re-filed as client A's memory.

### Summaries

- Written on Zima by the Cerebro service running Claude Code headless (`claude
  -p`), logged in with the owner's Claude subscription (same pattern Paperclip
  uses on this server), using the Haiku model.
- Triggered at session end, and periodically during long sessions (builder
  picks the threshold — by elapsed time or new-content volume).
- Summaries are produced on the server, so they still get written after the Mac
  that had the conversation goes to sleep.
- **Budget (owner's decision):** the summariser may use about **20%** of the
  subscription's usage limits, configurable. When it reaches its share it
  defers work; live sessions are summarised before the import backlog. The
  builder decides how to measure the share (e.g. from usage/rate-limit
  information Claude Code reports, or a token budget per limit window
  calibrated to the plan) and documents it.
- If the subscription login expires or limits are hit, pending summaries queue
  and retry; the health endpoint reports the backlog, budget use, and the login
  state. Raw capture is never affected.

### Recall inside Claude Code

- **Session-start brief:** for a bound folder, inject a short brief (a few hundred
  words at most) built from the project state document: current state, open
  threads, recent decisions for the current scope.
- **Tools for Claude** (via the plugin): search (hybrid full-text + vector over
  summaries and conversation chunks, filterable by date range), open a time
  range / session, and quote raw conversation spans. Progressive disclosure:
  search returns compact hits; full text is fetched only on request.
- **Scoping rule (owner's decision):**
  - Folder bound to a **project** → Claude can only see that project's memories
    (not the rest of the client's).
  - Folder bound to a **client only**, or **not bound** → Claude may search
    across all clients.
  - This is enforced by the client plugin passing the scope; it guards against
    accidental cross-client leakage, not against a deliberately misused token.

### Query API

- Plain HTTP + JSON at `http://cerebro.home.lab`.
- Capabilities: list clients/projects/sessions; search with filters (client,
  project, date range, free text); read summaries; fetch raw conversation spans
  for quoting; manage bindings; health/status. Ingest endpoints for the plugin.
- **Auth:** bearer token required on every endpoint except a minimal health
  check. One token per machine so a lost machine can be revoked alone.
  Tokens are stored on the Macs outside any repo.
- LAN-only, behind the existing Caddy (`cerebro.home.lab`).

### Operations

- Repo: this folder (`/Volumes/Content/projects/Cerebro`), following the
  `HomeLab/*` repo conventions (`deploy.sh`, `check.sh`, README with owner steps).
- Registered as a ZimaOS app with a dashboard tile; added to Caddy and the
  `home.lab` directory page.
- Secrets (machine tokens' hashes, DB password) under `/DATA/AppData/cerebro/`
  root-only, never printed.
- **Backups:** Cerebro's own policy, sized for an ever-growing database on the
  256 GB backup drive (builder picks, e.g. less frequent full dumps with short
  retention, or a dump + incremental scheme). Restore must be tested once.

## Left to the builder

- Exact Postgres schema, indexes, and migrations tooling.
- Embedding model and runtime (CPU-only on a 2400GE; a multilingual model is
  preferred in case some conversations are in Spanish), chunk sizes, and the
  hybrid ranking.
- Exact hook events and capture mechanism (see Capture).
- Secret-pattern list and the redaction marker format.
- Summary trigger thresholds and the summary prompt/format.
- Whether the Claude-side tools are an MCP server or skill + CLI.
- Backup scheme within the constraints above.
- Plugin distribution mechanism (local marketplace, git repo, etc.).
- Whether subagent transcripts are captured as part of their parent session.
- How the summariser measures its subscription share (see Summaries).
- The initial-history prompt and how far back it reads git history.
