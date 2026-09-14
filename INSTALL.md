# Installing Chamber

Chamber is a single Node.js file with **no dependencies** — no `npm install`, no
database, no build step. If you can run `node`, you can run Chamber.

- [Requirements](#requirements)
- [Quick start (local)](#quick-start-local)
- [Production install (systemd)](#production-install-systemd)
- [Turning on authentication](#turning-on-authentication)
- [Exposing it publicly (reverse proxy + TLS)](#exposing-it-publicly-reverse-proxy--tls)
- [Configuration reference](#configuration-reference)
- [Updating](#updating)
- [Backups](#backups)
- [Uninstall](#uninstall)

---

## Requirements

- **Node.js ≥ 18** (Chamber uses only built-in modules). Debian 13 ships a
  compatible `nodejs` package: `sudo apt install -y nodejs`.
- Any Linux, macOS, or Windows host. ~10 MB of disk.

Check your version:
```bash
node --version   # v18 or newer
```

---

## Quick start (local)

```bash
git clone git@github.com:GhostPortTechnologies/Chamber.git
cd Chamber
node server.js
```
Open <http://127.0.0.1:4242>, choose a name, and you're in. With no password set
and the default loopback bind, it runs open on your machine only.

---

## Production install (systemd)

```bash
# 1. Put the app somewhere stable
sudo mkdir -p /opt/chamber
sudo cp -r server.js public /opt/chamber/

# 2. Install the service unit
sudo cp chamber.service /etc/systemd/system/chamber.service
#    (edit it first if you changed the path — see the unit's comments)

# 3. Set an access password BEFORE exposing it (see next section), then:
sudo systemctl daemon-reload
sudo systemctl enable --now chamber
sudo systemctl status chamber          # confirm it's running
```
The unit runs as a locked-down `DynamicUser` and keeps its data in
`/var/lib/chamber` (created automatically). Logs: `journalctl -u chamber -f`.

---

## Turning on authentication

Chamber has **no auth by default** and will **refuse to start on a non-loopback
address unless a password is set** — this is deliberate, so you can't
accidentally publish an open board.

**Option A — plaintext secret (simplest):**
```bash
# in the systemd unit, add:  Environment=CHAMBER_PASSWORD=your-strong-secret
# or in a .env file next to server.js:  CHAMBER_PASSWORD=your-strong-secret
```

**Option B — pre-hashed (keeps the plaintext out of your config/env):**
```bash
read -rs -p "Access password: " P && echo && P="$P" node -e \
'const c=require("crypto"),s=c.randomBytes(16).toString("hex");\
console.log("CHAMBER_PASSWORD_HASH="+s+":"+c.scryptSync(process.env.P,s,32).toString("hex"))'; unset P
```
Paste the printed `CHAMBER_PASSWORD_HASH=salt:hash` line into your unit/.env.
The password is never written to disk or shell history.

Everyone who has the password can log in and pick a display name. Chamber is
built for a **trusted team behind one shared secret** — authenticated users are
trusted (display name and role are honor-system). It is not designed for
mutually-distrusting users on the same instance.

---

## Exposing it publicly (reverse proxy + TLS)

Run Chamber on loopback and put a TLS-terminating reverse proxy in front. Never
serve it over plain HTTP on a public network.

```nginx
server {
  listen 443 ssl;
  server_name chamber.example.com;
  ssl_certificate     /etc/letsencrypt/live/chamber.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chamber.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:4242;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```
Then set **`CHAMBER_SECURE_COOKIE=1`** so the session cookie is only sent over
HTTPS. Keep `CHAMBER_HOST=127.0.0.1` (the proxy reaches it on loopback).

If instead you bind Chamber directly to a public interface
(`CHAMBER_HOST=0.0.0.0`), you **must** set a password or it won't start.

---

## Configuration reference

All optional; set via the systemd unit's `Environment=`, a `.env` file, or the shell.

| Variable | Default | Purpose |
|---|---|---|
| `CHAMBER_PORT` | `4242` | Listen port |
| `CHAMBER_HOST` | `127.0.0.1` | Bind address |
| `CHAMBER_PASSWORD` | *(off)* | Shared access secret (scrypt-hashed at boot) |
| `CHAMBER_PASSWORD_HASH` | *(off)* | Pre-hashed `salt:hash` (use instead of the above) |
| `CHAMBER_SECURE_COOKIE` | `0` | Set `1` when served over HTTPS |
| `CHAMBER_DATA` | `./chamber.json` | Chat/user store |
| `CHAMBER_REVIEWS` | `./reviews.json` | Code-review store |
| `CHAMBER_ACCENT` | `#00ff88` | Default UI accent (users can override in the app) |
| `CHAMBER_REPO_ROOT` | *(off)* | git repo to enable the Reviews diff feature |
| `CHAMBER_THEME_FILE` | *(off)* | `{ "color": "#rrggbb" }` for a server-set default accent |
| `CHAMBER_TICKETS_FILE` / `CHAMBER_TICKETS_CLI` | *(off)* | External ticket integration |

Health check for load balancers: `GET /api/health` (open, no auth).

---

## Updating

```bash
cd /path/to/checkout && git pull
sudo cp -r server.js public /opt/chamber/
sudo systemctl restart chamber
```
Your data in `/var/lib/chamber` (or `CHAMBER_DATA`) is untouched.

---

## Backups

`chamber.json` and `reviews.json` are plain JSON, written atomically. Back up by
copying them:
```bash
cp /var/lib/chamber/chamber.json /var/lib/chamber/reviews.json /your/backup/
```

---

## Uninstall

```bash
sudo systemctl disable --now chamber
sudo rm /etc/systemd/system/chamber.service /opt/chamber -r
sudo rm -rf /var/lib/chamber        # deletes chat history — omit to keep it
sudo systemctl daemon-reload
```
