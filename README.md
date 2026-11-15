# Chamber

**Your developers move at AI speed. Your business keeps the approvals and the record.**

Vet, log and review the work your AI agents do, as a team or on your own.

Chamber keeps developers, AI coding agents and the business in step: chat, tickets, code review, files and a
record of everything that was done. An agent proposes a job; a person approves it before it starts; the agent
does it on your machine, with your own AI account; every step goes on a record the team can read. Nothing runs
until a person says yes. It works in any browser, on a computer or a phone. How it compares with other tools:
<https://chamber.ghostporttechnologies.com/compare>

- **Hosted for you:** <https://chamber.ghostporttechnologies.com> (free trial, then a small yearly price per
  workspace; see the site). Watch the demo without signing up: <https://chamber.ghostporttechnologies.com/demo>
- **Run it yourself:** free under the AGPL. One command on Linux (`curl -fsSL https://chamber.ghostporttechnologies.com/self-host.sh | bash`) or Windows (`irm https://chamber.ghostporttechnologies.com/self-host.ps1 | iex`); servers and Docker: [SELF-HOSTING.md](SELF-HOSTING.md) and [INSTALL.md](INSTALL.md).
- **Agents:** the chat connector and the ticket worker are in [`agent/`](agent/README.md). Claude Code is the main
  agent; OpenAI-compatible services, Gemini and local Ollama models can answer too.
- **Help and API reference:** <https://chamber.ghostporttechnologies.com/help>

This repository holds the source of the hosted service. It is published in steps, so the history here is coarser
than the public changelog at <https://chamber.ghostporttechnologies.com/changelog>. The exact source of the version
that is running can always be downloaded from `/source` on the site.

## Why it's easy to run

- **No npm packages.** Only Node.js built-ins. Nothing to `npm install`, no native modules to compile.
- **No database server.** Messages are kept in SQLite files through Node's built-in `node:sqlite`; accounts,
  tickets and reviews are JSON files. Everything is created on first use.
- **Needs Node 22.13 or newer** (for `node:sqlite`). Many distributions still ship an older Node.

## Quick start

```bash
node server.js
# → Chamber running on http://127.0.0.1:4242
```

Open <http://127.0.0.1:4242>, pick a name, and you're in.

## Install as a service

See **[INSTALL.md](INSTALL.md)** for the single-board install (systemd unit, password, HTTPS) and
**[SELF-HOSTING.md](SELF-HOSTING.md)** for workspaces with accounts, roles, two-factor sign-in and agents
(Docker or plain Linux). The scripts we run the hosted service with are in [`ops/`](ops/README.md).

## Configuration

Everything is set through environment variables (in the systemd unit's
`Environment=` lines, your shell, or a `.env` file next to `server.js`).
All are **optional** — the defaults give you a working chat + code pad.

| Variable | Default | Purpose |
|---|---|---|
| `CHAMBER_PORT` | `4242` | Listen port |
| `CHAMBER_HOST` | `127.0.0.1` | Bind address. On a non-loopback address a password is **required** or the app won't start. |
| `CHAMBER_PASSWORD` | *(off)* | Shared access secret (scrypt-hashed at boot). Enables login. |
| `CHAMBER_PASSWORD_HASH` | *(off)* | Pre-hashed `salt:hash` — use instead of `CHAMBER_PASSWORD` to keep plaintext out of your config |
| `CHAMBER_SECURE_COOKIE` | `0` | Set `1` when served over HTTPS |
| `CHAMBER_DATA` | `./chamber.json` | Chat/user store |
| `CHAMBER_REVIEWS` | `./reviews.json` | Code-review store |
| `CHAMBER_ACCENT` | `#00ff88` | Default UI accent (each user can override it live in the app) |
| `CHAMBER_REPO_ROOT` | *(off)* | Point at a git repo to enable the **Reviews** diff feature |
| `CHAMBER_THEME_FILE` | *(off)* | JSON file `{ "color": "#rrggbb" }` for a server-set default accent |
| `CHAMBER_TICKETS_FILE` | *(off)* | Host ticket JSON to read into the **Tickets** tab |
| `CHAMBER_TICKETS_CLI` | *(off)* | CLI invoked to create/mutate tickets. The bundled `tickets-cli.js` works out of the box: point this at it and `CHAMBER_TICKETS_FILE` at where it should keep the store. |

Any integration left unset simply makes its tab return empty — the app never
errors on a missing path. See `.env.example`, and **[INSTALL.md](INSTALL.md)** for
full setup including auth and TLS.

## What's built in vs. optional

- **Always on:** chat, rooms, presence, activity timeline, the code-review pad
  (100% client-side), and the **theme picker** — pick an accent in the header
  (presets or a custom color); it saves per-browser and recolors the whole UI.
- **Optional (need config):** the Reviews git-diff feature (`CHAMBER_REPO_ROOT`),
  Tickets (`CHAMBER_TICKETS_FILE`/`CHAMBER_TICKETS_CLI`), a server-set default
  accent (`CHAMBER_THEME_FILE`).

## Tickets

Point `CHAMBER_TICKETS_CLI` at the bundled `tickets-cli.js` and
`CHAMBER_TICKETS_FILE` at a writable path (for example
`/var/lib/chamber/tickets.json`), and the **Tickets** tab can propose, approve,
claim, update and close tickets. Lifecycle: proposed -> approved -> in_progress
-> done (or proposed -> rejected).

- **Closing needs a note.** MARK DONE asks for one, and the CLI refuses
  `close` without `--note` (20+ characters). Name each item in the ticket and
  its result; if something was not done, say so and leave the ticket open. The
  note is kept in the ticket's history. Only approved or in-progress tickets
  can be closed.
- **The store is never overwritten by accident.** If the ticket file can't be
  read or isn't valid JSON (for example after a hand edit), the CLI stops with
  an error and leaves the file exactly as it was.
- **Export.** `GET /api/tickets/export` returns the board as a printable page
  (open it, then Ctrl+P and Save as PDF). Add `format=md` or `format=csv` for
  Markdown or a spreadsheet, `download=1` to save a file, and filter with
  `open=1`, `status=`, `priority=`, `assignee=` or `q=` (search). `full=1`
  includes ticket bodies; without it the export is titles and metadata only.
  It sits behind the same login as the rest of the API.

## Security

- **Authentication.** Set `CHAMBER_PASSWORD` (or `CHAMBER_PASSWORD_HASH`) to
  require a shared access secret at login. Passwords are hashed with scrypt;
  sessions are random 256-bit tokens carried in an HttpOnly, `SameSite=Strict`
  cookie (and returned as a bearer token for API clients). Login is rate-limited.
- **Fail-closed.** With no password set, Chamber runs **only on loopback**. Bind
  it to a non-loopback address without a password and it **refuses to start** —
  so you can't accidentally publish an open board.
- **Behind HTTPS.** Terminate TLS at a reverse proxy and set
  `CHAMBER_SECURE_COOKIE=1`. Full walkthrough in [INSTALL.md](INSTALL.md).
- **Trust model.** Chamber is for a **trusted team behind one shared secret** —
  authenticated users are trusted (display name and role are honor-system). It's
  not designed for mutually-distrusting users on a single instance.

## Data & backups

Chat is kept in SQLite (`chamber.db` next to `chamber.json`, and one database per workspace under `ws/<id>/` when
accounts are on); accounts, tickets and reviews are JSON files written atomically (temp file, fsync, rename).
Do not copy a live database file by hand: use `node tools/snapshot.js <data-dir> <dest-dir>`, which takes a
consistent copy of every database and checks it. `ops/chamber-backup` and `ops/chamber-restore-drill` are the
nightly backup and the weekly restore test we run ourselves. Data files are git-ignored.

## Hosted mode: accounts, workspaces, paywall

Set `CHAMBER_ACCOUNTS=1` (plus the Stripe variables, see `accounts.js`) and Chamber becomes a multi-tenant service:

- **Landing page** at `/`, sign-up / login / account page (`/signup`, `/login`, `/billing`), legal pages (`/terms`, `/privacy`, `/refunds`).
- **Workspaces**: every account owns or belongs to one; chat (SQLite, `store.js`), tickets, reviews, presence and the
  activity feed are per workspace (`<data dir>/ws/<id>/`). Invite links (`/join/<code>`) add members; the owner's
  Stripe subscription covers them. `node test_isolation.js` proves nothing crosses between workspaces (run it before every release).
- **AI agents**: owners create agent tokens (`chk_…`) on the account page; `agent/chamber-agent.py` connects a Claude Code
  installation that answers @mentions and DMs, obeys only the configured commanders, and files changes it cannot make as tickets.
  Every agent write is in the workspace audit log.
- **Live updates** over server-sent events (`/api/events`), **mentions and direct messages**, markdown and code blocks,
  pasted-diff reviews, installable app with push notifications (`push.js`), password reset by email (`mail.js`).
- **Source offer**: `/source` serves a tarball of the exact commit that is running (AGPL §13).
- **Files** (T-0064): paste or drop screenshots and files into chat (`POST /api/files`, `attachments` on messages); stored under `ws/<id>/files/`, room-scoped access, inline images, sandboxed downloads; connectors hand them to the model.
- **Agent transparency** (T-0071): an agent's "on it…" line carries a live `run` record (steps, a transcript of every command with output and exit code,
  model, tokens, time, cost); people press Stop (`POST /api/messages/stop`), the connector sees it on `GET /api/messages/one`; the line becomes the answer
  when done (one message per request); `/api/ping` carries state / room / task / last error for the sidebar. Connector 3.6.0 runs Claude Code with `--output-format stream-json`.
- **Webhooks and CLI** (T-0074): incoming webhooks post as a named bot identity (or as the creator when they instruct an agent); GitHub `ping` / `push` (commit list + compare link) / `pull_request` / `issues` / `release` / `workflow_run` / `check_run` read well without glue code; `public/chamber-cli.py` is a zero-dependency client (`login`, `post`, `files up|ls`, `tickets ls|show|approve|reject|close`, `tail`, `search`) exercised by test_isolation.js.
- **Threads and reactions** (T-0070): `POST /api/messages/react` (fixed set, `reactions` on messages), `GET /api/messages/replies` (root + everything under it), thread summaries on roots, a side panel / phone sheet with its own reply box, a per-device collapse mode; connector 3.8.0 reacts 👀 while working and ✅ / ❌ when done.
- **Composer power tools** (T-0069): @ / # / T- autocomplete, slash commands (`/ticket /review /status /me /dm /remind /files /build /shrug /help`; `/remind` makes a one-shot schedule via `once: true`), per-room drafts, search operators (`from: in: has:file|code|link is:ticket before: after:` → `/api/search` filters), pins (`POST /api/messages/pin`, `GET /api/messages/pins`, `pinned` on messages), hover actions + long-press sheet on phones.
- **Themes and comfort** (T-0073): light / system / high-contrast themes on the shared tokens (`--accent-pick` is the user's choice, `--accent` the readable derivative; same blocks on the account, help and API pages), text size and density, New-messages line + jump pill, relative timestamps, sidebar sections (Starred / Rooms / DMs with star, drag order, collapse, filter), skeleton loaders, focus rings, reduced motion, live region. `node test_theme.js` checks WCAG AA on every theme's token pairs.
- **Rich messages** (T-0068): `public/markdown.js` is one renderer for chat and tickets (headings, lists, task boxes, tables, quotes, strikethrough, links, mentions, ticket and commit links) with syntax colours for a dozen languages and line numbers; a composer secret guard (`findSecrets`/`redact`), a paste-to-code-block offer, and `#m=<id>` permalinks. `node test_markdown.js` holds the fixtures (also run from test_isolation.js).
- **Vibe-coder mode** (T-0072): Build dialog → `BUILD REQUEST` → plan + ticket; recipe chips; screenshot → fix; `PLAIN:` summary and risk pill on every diff (`plain` on the diff route); one-tap Revert (`/api/tickets/<id>/revert` reverses the stored patch, `apply_by` routes it to the agent that applied the original, `/applied` records where it landed); voice input; per-person `prefs.plain` (`/api/me/prefs`) honoured by connector 3.7.0; one-tap daily `DIGEST` schedule.
- **Bring your own model**: `agent/chamber-agent.py` drives Claude Code (locked tool sandbox) or, with `CHAMBER_BACKEND=ollama|openai|gemini`,
  any Ollama / OpenAI-compatible / Gemini model with operator-allowlisted read-only context commands. `python3 agent/test_connector.py` runs the
  backend tests against fake servers.

Everything is still Node built-ins only. The classic single-board install (no `CHAMBER_ACCOUNTS`) behaves as before.

## License

[GNU AGPL-3.0-only](LICENSE). You may use, modify, and self-host Chamber freely.
If you modify it and offer it to others over a network, you must make the source
of your modified version available to those users. See the [LICENSE](LICENSE) file.

Copyright (C) 2026 GhostPort Technologies.
