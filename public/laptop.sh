#!/bin/sh
# Chamber on your own computer, without admin rights (T-0186). macOS and Linux; on Windows, run it inside WSL.
# Run it in the folder of the one project you want the agent to help with:
#
#   cd ~/code/my-project
#   curl -fsSL https://chamber.ghostporttechnologies.com/laptop.sh | sh -s -- --token chk_...
#
# Without --token it shows a 6-digit pairing code instead, which an owner or admin enters in Chamber (Account, AI agents).
# Options: --token chk_...   --commanders a,b   --rooms general   --workdir /path   --backend claude|ollama|openai|gemini
#          --model NAME      --url https://chamber.example.com
#          --token -         ask for the key instead (it is then not left in this computer's command history)
#          --background      keep it running after the terminal closes, and start it again at log-in
#                            (a launchd agent on macOS, a user service on Linux)
#          --stop            stop the background agent        --uninstall   remove everything this script put here
# Everything stays in your own home folder: ~/.chamber (the agent and its state) and ~/.config/chamber/agent.env (its
# settings and key, readable only by you). Nothing needs sudo. The agent reads the project folder and does not change it,
# unless you change CHAMBER_ALLOWED_TOOLS in that settings file yourself.
# SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
set -eu
URL=https://chamber.ghostporttechnologies.com; TOKEN=""; COMMANDERS=""; ROOMS=""; WORKDIR=""; BACKEND=""; MODEL=""
BG=0; STOP=0; UNINSTALL=0; NOSTART=${CHAMBER_NO_START:-0}      # CHAMBER_NO_START=1: set everything up but start nothing (tests)
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN=${2:-}; shift 2;; --commanders) COMMANDERS=${2:-}; shift 2;; --rooms) ROOMS=${2:-}; shift 2;;
    --workdir) WORKDIR=${2:-}; shift 2;; --backend) BACKEND=${2:-}; shift 2;; --model) MODEL=${2:-}; shift 2;;
    --url) URL=${2%/}; shift 2;; --background) BG=1; shift;; --stop) STOP=1; shift;; --uninstall) UNINSTALL=1; shift;;
    -h|--help) echo "See the top of $URL/laptop.sh"; exit 0;;
    *) echo "Chamber: unknown option $1" >&2; exit 2;;
  esac
done
say() { printf '%s\n' "$*"; }
die() { printf 'Chamber: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" != 0 ] || die "this is the version for your own computer and needs no admin rights. Run it as yourself, without sudo. On a server, use $URL/install.sh instead."
if [ "$TOKEN" = "-" ]; then                                        # T-0217: ask for the key, so it is not left in this computer's command history
  TOKEN=""
  if (exec < /dev/tty) 2>/dev/null; then
    printf 'Paste the agent key from Chamber (it starts with chk_ and will not be shown), then press Enter: ' > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true; IFS= read -r TOKEN < /dev/tty || TOKEN=""; stty echo < /dev/tty 2>/dev/null || true; printf '\n' > /dev/tty
    TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
  fi
  [ -n "$TOKEN" ] || die "the key could not be read: run this in a terminal window and paste the key when asked, or put it after --token."
fi
OS=$(uname -s)
case "$OS" in Darwin|Linux) ;; *) die "this works on macOS and Linux (on Windows, inside WSL). This computer says it is: $OS";; esac
DIR=$HOME/.chamber
CONFDIR=${XDG_CONFIG_HOME:-$HOME/.config}/chamber
CONF=$CONFDIR/agent.env
LABEL=com.ghostporttechnologies.chamber-agent
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/chamber-agent.service

stop_bg() {
  if [ "$OS" = Darwin ]; then
    if [ -f "$PLIST" ]; then launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true; fi
  elif command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now chamber-agent >/dev/null 2>&1 || true; fi
}
if [ "$STOP" = 1 ]; then stop_bg; say "The background agent is stopped. Start it again with: curl -fsSL $URL/laptop.sh | sh -s -- --background"; exit 0; fi
if [ "$UNINSTALL" = 1 ]; then
  stop_bg; rm -f "$PLIST" "$UNIT"; rm -rf "$DIR"; rm -f "$CONF" "$CONF.new"; rmdir "$CONFDIR" 2>/dev/null || true
  say "Removed the agent, its settings and its key from this computer."
  say "Also delete its key in Chamber (Account, AI agents), so it can never be used again."
  exit 0
fi

PY=$(command -v python3 || true)
[ -n "$PY" ] || die "Python 3 is needed. On a Mac, run  xcode-select --install  (or install Python from python.org). On Linux, install the python3 package."
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null || die "Python 3.8 or newer is needed. This computer has: $("$PY" -V 2>&1 || echo 'a Python that does not start')"
CLAUDE=$(command -v claude || true)
if [ -z "$CLAUDE" ]; then for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do if [ -x "$c" ]; then CLAUDE=$c; break; fi; done; fi
if [ -z "$CLAUDE" ] && [ "${BACKEND:-claude}" = claude ]; then
  say "Note: Claude Code was not found on this computer. The agent will connect, but it can only answer once Claude Code is installed and signed in."
fi

[ -n "$WORKDIR" ] || WORKDIR=$(pwd)
WORKDIR=$(cd "$WORKDIR" 2>/dev/null && pwd) || die "there is no folder $WORKDIR"
case "$WORKDIR" in
  "$HOME"|/|/Users|/home|/tmp|/root) die "run this inside one project folder (cd into it first), not in $WORKDIR. The agent can read everything in the folder it works in, so give it only the project.";;
esac

umask 077
mkdir -p "$DIR" "$CONFDIR"; chmod 700 "$DIR" "$CONFDIR"
say "Downloading the agent from $URL"
curl -fsSL "$URL/agent/chamber-agent.py" -o "$DIR/chamber-agent.py.new" || die "could not download $URL/agent/chamber-agent.py"
head -1 "$DIR/chamber-agent.py.new" | grep -q python || { rm -f "$DIR/chamber-agent.py.new"; die "the download does not look like the agent. Nothing was changed."; }
mv "$DIR/chamber-agent.py.new" "$DIR/chamber-agent.py"

setv() {                                                          # KEY=VALUE into the settings file, replacing an older line for KEY
  touch "$CONF"; chmod 600 "$CONF"
  grep -v "^$1=" "$CONF" > "$CONF.new" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$CONF.new"; mv "$CONF.new" "$CONF"; chmod 600 "$CONF"
}
if [ -n "$TOKEN" ]; then
  case "$TOKEN" in chk_*) ;; *) die "that does not look like an agent key (they start with chk_)";; esac
  setv CHAMBER_URL "$URL"; setv CHAMBER_TOKEN "$TOKEN"
elif ! grep -q '^CHAMBER_TOKEN=chk_' "$CONF" 2>/dev/null; then
  say ""; say "No key was given, so this computer pairs with a code instead."
  "$PY" "$DIR/chamber-agent.py" --pair "$URL" --write "$CONF" || die "pairing did not finish. Run this again for a new code."
fi
setv CHAMBER_INSTALL laptop
setv CHAMBER_WORKDIR "$WORKDIR"
setv CHAMBER_STATE "$DIR/state.json"
if [ -n "$CLAUDE" ]; then setv CHAMBER_CLAUDE_BIN "$CLAUDE"; fi
if [ -n "$COMMANDERS" ]; then setv CHAMBER_COMMANDERS "$COMMANDERS"; fi
if [ -n "$ROOMS" ]; then setv CHAMBER_ROOMS "$ROOMS"; fi
if [ -n "$BACKEND" ]; then setv CHAMBER_BACKEND "$BACKEND"; fi
if [ -n "$MODEL" ]; then setv CHAMBER_MODEL "$MODEL"; fi
grep -q '^CHAMBER_ALLOWED_TOOLS=' "$CONF" || setv CHAMBER_ALLOWED_TOOLS "Read,Grep,Glob"

# A background agent does not get your terminal's PATH, so give it the folders where python, claude and node live.
P=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
for b in "$PY" "$CLAUDE" "$(command -v node || true)"; do if [ -n "$b" ]; then P=$(dirname "$b"):$P; fi; done

if [ "$BG" = 1 ]; then
  if [ "$OS" = Darwin ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DIR/chamber-agent.py</string><string>--env</string><string>$CONF</string></array>
  <key>WorkingDirectory</key><string>$WORKDIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$P</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/agent.log</string><key>StandardErrorPath</key><string>$DIR/agent.log</string>
</dict></plist>
PL
    if [ "$NOSTART" != 1 ]; then
      launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" || die "macOS did not accept the background agent. Run it without --background instead."
    fi
    LOGHINT="tail -f ~/.chamber/agent.log"
  else
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UN
[Unit]
Description=Chamber agent (laptop install, T-0186)
After=network-online.target

[Service]
ExecStart="$PY" "$DIR/chamber-agent.py" --env "$CONF"
WorkingDirectory=$WORKDIR
Environment="PATH=$P"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
UN
    if [ "$NOSTART" != 1 ]; then
      systemctl --user daemon-reload && systemctl --user enable --now chamber-agent || die "could not start it as a user service. Run it without --background instead."
    fi
    LOGHINT="journalctl --user -u chamber-agent -f"
  fi
  say "Done. The agent runs in the background and starts again when you log in. It works in $WORKDIR and reads it without changing it."
  say "See what it does: $LOGHINT"
  say "Stop it: curl -fsSL $URL/laptop.sh | sh -s -- --stop      Remove it: curl -fsSL $URL/laptop.sh | sh -s -- --uninstall"
  exit 0
fi
say "Starting the agent. It works in $WORKDIR and reads it without changing it."
say "Leave this window open; Ctrl+C stops it. To keep it running after you close the window, run this again with --background."
if [ "$NOSTART" = 1 ]; then exit 0; fi
cd "$WORKDIR"
exec "$PY" "$DIR/chamber-agent.py" --env "$CONF"
