# Chamber

A lightweight, self-hosted coordination board — real-time chat, presence, an
activity timeline, and a line-numbered **code-review pad** — in a single Node.js
file with **zero dependencies**.

## Why it's easy to run

- **No npm packages.** Only Node.js built-ins (`http`, `fs`, `path`,
  `child_process`). Nothing to `npm install`, no native modules to compile.
- **Flat-file storage.** Chat lives in `chamber.json`, reviews in
  `reviews.json`, both created automatically on first write. No database.
- **Runs on any Node ≥ 18** — including the `nodejs` package in Debian 13.

## Quick start

```bash
node server.js
# → Chamber running on http://127.0.0.1:4242
```

Open <http://127.0.0.1:4242>, pick a name, and you're in.

## Install on Debian 13 (systemd service)

```bash
sudo apt update && sudo apt install -y nodejs
sudo mkdir -p /opt/chamber
sudo cp -r server.js public /opt/chamber/
sudo cp chamber.service /etc/systemd/system/chamber.service
# edit the unit if you changed the path/user, then:
sudo systemctl daemon-reload
sudo systemctl enable --now chamber
```

## Configuration

Everything is set through environment variables (in the systemd unit's
`Environment=` lines, your shell, or a `.env` file next to `server.js`).
All are **optional** — the defaults give you a working chat + code pad.

| Variable | Default | Purpose |
|---|---|---|
| `CHAMBER_PORT` | `4242` | Listen port |
| `CHAMBER_HOST` | `127.0.0.1` | Bind address. **Keep loopback unless you add auth** (see Security). |
| `CHAMBER_DATA` | `./chamber.json` | Chat/user store |
| `CHAMBER_REVIEWS` | `./reviews.json` | Code-review store |
| `CHAMBER_ACCENT` | `#39ff8f` | UI accent color |
| `CHAMBER_REPO_ROOT` | *(off)* | Point at a git repo to enable the **Reviews** diff feature |
| `CHAMBER_THEME_FILE` | *(off)* | JSON file `{ "color": "#rrggbb" }` for live accent theming |
| `CHAMBER_TICKETS_FILE` | *(off)* | Host ticket JSON to read into the **Tickets** tab |
| `CHAMBER_TICKETS_CLI` | *(off)* | CLI invoked to create/mutate tickets |

Any integration left unset simply makes its tab return empty — the app never
errors on a missing path. See `.env.example`.

## What's built in vs. optional

- **Always on:** chat, rooms, presence, activity timeline, the code-review pad
  (the paste-and-read tool is 100% client-side).
- **Optional (need config):** the Reviews git-diff feature (`CHAMBER_REPO_ROOT`),
  Tickets (`CHAMBER_TICKETS_FILE`/`CHAMBER_TICKETS_CLI`), live theming
  (`CHAMBER_THEME_FILE`).

## Security

Chamber currently uses **name-based identity, not authentication** — anyone who
can reach the port can read and post. That is safe only while it is bound to
`127.0.0.1` (the default). **Before exposing it on a network**, either put it
behind a reverse proxy that enforces auth, or add authentication to the app.
Binding to a non-loopback address prints a startup warning as a reminder.

## Data & backups

`chamber.json` and `reviews.json` are plain JSON, written atomically
(temp-file + fsync + rename) so a crash can't corrupt them. Back them up by
copying the files. They are git-ignored by default so history/reviews don't get
committed.

## License

Currently `UNLICENSED` (all rights reserved). Pick and add a `LICENSE` file
before distributing.
