#!/usr/bin/env bash
# Chamber on your own Linux computer (T-0226). Free and open source (AGPL-3.0-only), Copyright (C) 2026 GhostPort Technologies.
#
#   curl -fsSL https://chamber.ghostporttechnologies.com/self-host.sh | bash
#   curl -fsSL https://chamber.ghostporttechnologies.com/self-host.sh | bash -s -- --port 4242 --dir ~/chamber
#
# What it does: checks for Node.js 22.13 or newer, downloads the source of the version that runs on
# chamber.ghostporttechnologies.com, unpacks it in ~/chamber (app = the code, data = your workspaces), writes ~/chamber/start.sh
# and starts Chamber for this computer only, at http://localhost:4242. It needs no root, installs nothing else and sends nothing
# anywhere. Run it again to update: the code is replaced, your data and settings stay.
#
# Options: --dir DIR      where it lives (default ~/chamber)
#          --port N       the port on this computer (default 4242)
#          --service      also add a systemd user service, so it starts again after you log in
#          --no-start     only download and set up
#          --from URL     another Chamber to take the code from (https, or http on this computer)
set -euo pipefail

FROM="https://chamber.ghostporttechnologies.com"; DIR="$HOME/chamber"; PORT=4242; START=1; SERVICE=0
say() { printf '%s\n' "$*"; }
die() { printf 'Chamber: %s\n' "$*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || die "--dir needs a folder"; DIR="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port needs a number"; PORT="$2"; shift 2 ;;
    --from) [ $# -ge 2 ] || die "--from needs an address"; FROM="${2%/}"; shift 2 ;;
    --service) SERVICE=1; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) say "Usage: curl -fsSL $FROM/self-host.sh | bash -s -- [--dir DIR] [--port N] [--service] [--no-start]"; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
done
case "$FROM" in
  https://*|http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) ;;
  *) die "the code is only downloaded over https (or from this computer); got $FROM" ;;
esac
case "$PORT" in ''|*[!0-9]*) die "the port must be a number, like 4242" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "pick a port from 1024 to 65535"
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac

# 1. Node.js 22.13 or newer (Chamber's database is the SQLite built into Node)
if ! command -v node >/dev/null 2>&1; then
  die "Chamber needs Node.js 22.13 or newer, and this computer has none. Install Node.js 22 LTS (https://nodejs.org/en/download, or your package manager), then run this again."
fi
NV=$(node -p 'process.versions.node' </dev/null 2>/dev/null || echo 0.0.0); NMAJ=${NV%%.*}; NMIN=$(printf '%s' "$NV" | cut -d. -f2)
if [ "$NMAJ" -lt 22 ] || { [ "$NMAJ" -eq 22 ] && [ "$NMIN" -lt 13 ]; }; then
  die "Chamber needs Node.js 22.13 or newer; this computer has $NV. Install Node.js 22 LTS (https://nodejs.org/en/download), then run this again."
fi
command -v tar >/dev/null 2>&1 || die "tar is missing; install it with your package manager and run this again."
if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --proto '=https,http' "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q "$1" -O "$2"; }
else die "neither curl nor wget is installed; install one and run this again."; fi

# 2. The code: the version that runs at $FROM (its /source download, the same files as on GitHub)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
say "Downloading Chamber from $FROM ..."
fetch "$FROM/source" "$TMP/chamber.tar.gz" || die "could not download $FROM/source"
tar -xzf "$TMP/chamber.tar.gz" -C "$TMP" || die "the download is not a readable archive"
[ -f "$TMP/chamber/server.js" ] && [ -f "$TMP/chamber/tickets-cli.js" ] || die "the download does not look like Chamber"
mkdir -p "$DIR/data"; chmod 700 "$DIR/data"; QDIR=$(printf %q "$DIR")

# a copy started by this script before is stopped first, so the update takes effect
if [ -f "$DIR/chamber.pid" ]; then
  OLD=$(cat "$DIR/chamber.pid" 2>/dev/null || true)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null && grep -q "server.js" "/proc/$OLD/cmdline" 2>/dev/null; then say "Stopping the running copy ($OLD) ..."; kill "$OLD" 2>/dev/null || true
    for _ in $(seq 1 75); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.2; done   # it finishes what it is doing first; wait until it has let go of the port
    kill -0 "$OLD" 2>/dev/null && die "the running copy ($OLD) did not stop; stop it and run this again"; fi
  rm -f "$DIR/chamber.pid"
fi
if [ -d "$DIR/app" ]; then rm -rf "$DIR/app.old"; mv "$DIR/app" "$DIR/app.old"; fi
mv "$TMP/chamber" "$DIR/app"
if command -v git >/dev/null 2>&1; then                                    # so this copy's own /source and /changelog work (AGPL)
  ( cd "$DIR/app" </dev/null && git init -q && git add -A && git -c user.name=chamber -c user.email=chamber@localhost commit -qm "Chamber from $FROM" ) >/dev/null 2>&1 || true
fi

# 3. Settings: written once, then left alone (edit $DIR/chamber.env to change them)
if [ ! -f "$DIR/chamber.env" ]; then
  umask 077
  {
    say "# Chamber settings (self-hosted). Change and restart; see SELF-HOSTING.md for the rest."
    say "CHAMBER_ACCOUNTS=1"
    say "CHAMBER_SELF_HOSTED=1"
    say "CHAMBER_HOST=127.0.0.1"
    say "CHAMBER_PORT=$PORT"
    say "CHAMBER_PUBLIC_URL=http://localhost:$PORT"
    say "CHAMBER_DATA=$QDIR/data/chamber.json"
    say "CHAMBER_REVIEWS=$QDIR/data/reviews.json"
    say "CHAMBER_TICKETS_FILE=$QDIR/data/tickets.json"
    say "CHAMBER_TICKETS_CLI=$QDIR/app/tickets-cli.js"
  } > "$DIR/chamber.env"
else
  say "Keeping your settings in $DIR/chamber.env."
  PORT=$(sed -n 's/^CHAMBER_PORT=//p' "$DIR/chamber.env" | tail -1); PORT=${PORT:-4242}
fi
cat > "$DIR/start.sh" <<EOF
#!/usr/bin/env bash
# Start Chamber with the settings in chamber.env (written by self-host.sh).
set -a; . $QDIR/chamber.env; set +a
cd $QDIR/app && exec node --disable-warning=ExperimentalWarning server.js
EOF
chmod 700 "$DIR/start.sh"

# 4. Start it
up() { for _ in $(seq 1 50); do [ -z "${NEWPID:-}" ] || kill -0 "$NEWPID" 2>/dev/null || return 1; if node -e "fetch('http://127.0.0.1:$PORT/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1),()=>process.exit(1))" </dev/null 2>/dev/null; then return 0; fi; sleep 0.2; done; return 1; }
if [ "$SERVICE" = 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "--service needs systemd; start it with $DIR/start.sh instead"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/chamber.service" <<EOF
[Unit]
Description=Chamber (self-hosted, $DIR)
[Service]
ExecStart="$DIR/start.sh"
Restart=on-failure
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload && systemctl --user enable chamber.service >/dev/null && systemctl --user restart chamber.service
  up || die "the service did not come up; see: journalctl --user -u chamber -n 50"
  say "Chamber runs as your user service (starts when you log in; for start at boot, ask an admin to run: loginctl enable-linger $USER)."
elif [ "$START" = 1 ]; then
  nohup "$DIR/start.sh" </dev/null >> "$DIR/chamber.log" 2>&1 &
  NEWPID=$!; echo "$NEWPID" > "$DIR/chamber.pid"
  up && sleep 0.5 && kill -0 "$NEWPID" 2>/dev/null || die "Chamber did not come up; see $DIR/chamber.log"
fi

say ""
if [ "$START" = 1 ] || [ "$SERVICE" = 1 ]; then
  say "Chamber is running. Open http://localhost:$PORT in your browser and create your account: the first account owns the workspace."
else
  say "Chamber is set up. Start it with: $DIR/start.sh"
fi
say "  Your data:  $DIR/data (back it up with: node $DIR/app/tools/snapshot.js $DIR/data <backup folder>)"
[ "$SERVICE" = 1 ] || say "  Stop it:    kill \$(cat $DIR/chamber.pid)     Start again: $DIR/start.sh"
say "  Update:     run the same command again; your data and settings stay."
say "  It listens on this computer only. To use it from other devices, put it behind HTTPS first: see SELF-HOSTING.md."
