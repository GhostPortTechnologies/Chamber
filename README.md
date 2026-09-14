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
| `CHAMBER_TICKETS_CLI` | *(off)* | CLI invoked to create/mutate tickets |

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

`chamber.json` and `reviews.json` are plain JSON, written atomically
(temp-file + fsync + rename) so a crash can't corrupt them. Back them up by
copying the files. They are git-ignored by default so history/reviews don't get
committed.

## License

Currently `UNLICENSED` (all rights reserved). Pick and add a `LICENSE` file
before distributing.
