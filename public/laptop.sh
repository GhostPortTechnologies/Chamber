#!/bin/sh
# Chamber on your own computer, without admin rights (T-0186). macOS and Linux; on Windows, run it inside WSL.
#
#   curl -fsSL https://chamber.ghostporttechnologies.com/laptop.sh | sh -s -- --token chk_...
#
# The agent reads nothing on this computer until you attach a folder or a file (T-0218). The installer asks which folder, if
# any. Afterwards:  ~/.chamber/chamber-attach ~/code/my-project   (and --remove, --private, --everything, --nothing, --help).
# Without --token it shows a 6-digit pairing code instead, which an owner or admin enters in Chamber (Account, AI agents).
# Options: --token chk_...   --commanders a,b   --rooms general   --backend claude|ollama|openai|gemini
#          --model NAME      --url https://chamber.example.com
#          --attach /path    attach this folder or file now (may be given several times; then nothing is asked)
#          --no-attach       attach nothing and ask nothing       --workdir /path   the older name for --attach
#          --token -         ask for the key instead (it is then not left in this computer's command history)
#          --background      keep it running after the terminal closes, and start it again at log-in
#                            (a launchd agent on macOS, a user service on Linux; where there is no service manager,
#                            like Termux on an Android phone or a container, a small loop that restarts it: T-0319)
#          --stop            stop the background agent        --uninstall   remove everything this script put here
# Everything stays in your own home folder: ~/.chamber (the agent and its state) and ~/.config/chamber/agent.env (its
# settings and key, readable only by you). Nothing needs sudo. The agent reads what you attached and does not change it,
# unless you change CHAMBER_ALLOWED_TOOLS in that settings file yourself.
# SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
set -eu
URL=https://chamber.ghostporttechnologies.com; TOKEN=""; COMMANDERS=""; ROOMS=""; WORKDIR=""; BACKEND=""; MODEL=""; ATTACH=""; NOATTACH=0
NL="
"
ALLOWHTTP=0; BG=0; STOP=0; UNINSTALL=0; NOSTART=${CHAMBER_NO_START:-0}      # CHAMBER_NO_START=1: set everything up but start nothing (tests)
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN=${2:-}; shift 2;; --commanders) COMMANDERS=${2:-}; shift 2;; --rooms) ROOMS=${2:-}; shift 2;;
    --workdir|--attach) [ -n "${2:-}" ] || { echo "Chamber: $1 needs a folder" >&2; exit 2; }; ATTACH="$ATTACH$2$NL"; shift 2;; --no-attach) NOATTACH=1; shift;;
    --backend) BACKEND=${2:-}; shift 2;; --model) MODEL=${2:-}; shift 2;;
    --url) URL=${2%/}; shift 2;; --allow-http) ALLOWHTTP=1; shift;; --background) BG=1; shift;; --stop) STOP=1; shift;; --uninstall) UNINSTALL=1; shift;;
    -h|--help) echo "See the top of $URL/laptop.sh"; exit 0;;
    *) echo "Chamber: unknown option $1" >&2; exit 2;;
  esac
done
say() { printf '%s\n' "$*"; }
die() { printf 'Chamber: %s\n' "$*" >&2; exit 1; }
# T-0222: the agent key only travels over https. Plain http is taken for this computer itself, or when you say so with --allow-http.
case "$URL" in https://?*|http://127.0.0.1|http://127.0.0.1[:/]*|http://localhost|http://localhost[:/]*) ;; *)
  if [ "$ALLOWHTTP" = 1 ] || grep -qs '^CHAMBER_ALLOW_HTTP=1' "${XDG_CONFIG_HOME:-$HOME/.config}/chamber/agent.env"; then ALLOWHTTP=1
  else die "the Chamber address must start with https:// (got $URL). The agent key is never sent over plain http. If that address is inside a private network you trust, add --allow-http."; fi;; esac
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
  if [ -f "$DIR/agent.pid" ]; then kill "$(cat "$DIR/agent.pid")" 2>/dev/null || true; rm -f "$DIR/agent.pid"; fi   # T-0319: the keep-alive loop (it stops its agent too)
  if [ "$OS" = Darwin ]; then
    if [ -f "$PLIST" ]; then launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true; fi
  elif [ "${CHAMBER_NO_SYSTEMD:-0}" != 1 ] && command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now chamber-agent >/dev/null 2>&1 || true; fi
}
# T-0319: no service manager here (Termux on a phone, a container), or it would not start a user service: a small loop keeps the
# agent running and starts it again 10 s after it stops. It is run through sh (Termux has no /bin/sh for a #! line), and on
# TERM it stops the agent too. It does not come back after the phone or computer restarts.
start_loop() {
  cat > "$DIR/run-loop.sh" <<LOOP
# Chamber agent keep-alive (T-0319), written by laptop.sh where there is no service manager. Stop it: laptop.sh --stop
trap 'kill "\$c" 2>/dev/null; exit 0' TERM INT
while :; do "$PY" "$DIR/chamber-agent.py" --env "$CONF" >> "$DIR/agent.log" 2>&1 & c=\$!; wait "\$c"; sleep 10; done
LOOP
  chmod 600 "$DIR/run-loop.sh"
  if [ "$NOSTART" = 1 ]; then return 0; fi
  ( cd "$WORKDIR" || exit 1; PATH="$P"; export PATH; exec nohup sh "$DIR/run-loop.sh" >/dev/null 2>&1 ) & echo $! > "$DIR/agent.pid"   # exec: the saved number is the loop itself, so --stop reaches it
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

# T-0218: is this the first time attachments are set up here, and was an older install working in a project folder?
FIRST=1; if grep -q '^CHAMBER_REACH=' "$CONF" 2>/dev/null; then FIRST=0; fi
OLDWD=$(grep -s '^CHAMBER_WORKDIR=' "$CONF" | head -1 | cut -d= -f2- || true)

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
if [ "$ALLOWHTTP" = 1 ]; then setv CHAMBER_ALLOW_HTTP 1; fi
setv CHAMBER_STATE "$DIR/state.json"
setv CHAMBER_REACH attached                                       # T-0218: the agent reads only what is attached
setv CHAMBER_ATTACH_HINT "~/.chamber/chamber-attach <folder>"
if [ -n "$CLAUDE" ]; then setv CHAMBER_CLAUDE_BIN "$CLAUDE"; fi
if [ -n "$COMMANDERS" ]; then setv CHAMBER_COMMANDERS "$COMMANDERS"; fi
if [ -n "$ROOMS" ]; then setv CHAMBER_ROOMS "$ROOMS"; fi
if [ -n "$BACKEND" ]; then setv CHAMBER_BACKEND "$BACKEND"; fi
if [ -n "$MODEL" ]; then setv CHAMBER_MODEL "$MODEL"; fi
grep -q '^CHAMBER_ALLOWED_TOOLS=' "$CONF" || setv CHAMBER_ALLOWED_TOOLS "Read,Grep,Glob"

# ── T-0218: what the agent may read. Nothing, until a folder or file is attached; the list is kept in ~/.chamber/attached.json.
ATT=$DIR/chamber-attach
cat > "$ATT" <<AT
#!/bin/sh
# chamber-attach (T-0218): choose what the Chamber agent on this computer can read. Written by laptop.sh.
#   chamber-attach                   show what is attached        chamber-attach FOLDER-OR-FILE ...   attach it
#   chamber-attach --remove PATH     take it away again           chamber-attach --private PATH       for your eyes only
#   chamber-attach --unprivate PATH  --everything  --nothing  --help
exec "$PY" "$DIR/chamber-agent.py" --env "$CONF" --attach "\$@"
AT
chmod 700 "$ATT"
attach() { OUT=$("$ATT" "$@" 2>&1) || die "$OUT"; printf '%s\n' "$OUT" | grep '^Note: that is' || true; }   # the list itself is shown once, at the end
tilde() { case "$1" in "~") printf '%s' "$HOME";; "~/"*) printf '%s/%s' "$HOME" "${1#??}";; *) printf '%s' "$1";; esac; }
if [ -n "$ATTACH" ]; then                                         # named on the command line: attach exactly those, ask nothing
  while IFS= read -r AP; do if [ -n "$AP" ]; then attach "$AP"; fi; done <<LIST
$ATTACH
LIST
elif [ "$NOATTACH" = 1 ]; then :
elif [ "$FIRST" = 1 ] && [ -n "$OLDWD" ] && [ -d "$OLDWD" ]; then   # an install from before attachments: it was told "this project folder", and now that is exactly what it gets
  attach "$OLDWD"
  say "This agent was set up to work in $OLDWD. From this version it reads only what is attached, so that folder is now attached and nothing else on this computer is readable to it."
elif [ "$FIRST" = 1 ] && (exec < /dev/tty) 2>/dev/null; then       # first time, in a terminal: ask
  printf '\nThe agent reads nothing on this computer until you attach a folder.\n' > /dev/tty
  while :; do
    printf 'Folder to attach now (Enter for none; you can attach folders any time later): ' > /dev/tty
    IFS= read -r ANS < /dev/tty || ANS=""
    [ -n "$ANS" ] || break
    ANS=$(tilde "$ANS")
    if OUT=$("$ATT" "$ANS" 2>&1); then
      BASE=$(cd "$ANS" 2>/dev/null && pwd || true)
      while [ -n "$BASE" ]; do
        printf 'Anything inside it that is for your eyes only? Type a folder or file inside it (Enter for none): ' > /dev/tty
        IFS= read -r PRIV < /dev/tty || PRIV=""
        [ -n "$PRIV" ] || break
        PRIV=$(tilde "$PRIV"); case "$PRIV" in /*) ;; *) PRIV=$BASE/$PRIV;; esac
        OUT=$("$ATT" --private "$PRIV" 2>&1) || printf '%s\n' "$OUT" > /dev/tty
      done
      break
    fi
    printf '%s\n' "$OUT" > /dev/tty
  done
fi
# Where the agent process itself runs: the first attached folder, or an empty folder of its own. What it may READ is the attached list.
WORKDIR=$("$PY" -c 'import json, os, sys
try: d = json.load(open(sys.argv[1]))
except Exception: d = {}
print(next((p for p in d.get("paths", []) if isinstance(p, str) and os.path.isdir(p)), ""))' "$DIR/attached.json" 2>/dev/null || true)
if [ -z "$WORKDIR" ]; then WORKDIR=$DIR/work; mkdir -p "$WORKDIR"; fi
setv CHAMBER_WORKDIR "$WORKDIR"

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
  elif [ "${CHAMBER_NO_SYSTEMD:-0}" = 1 ] || ! command -v systemctl >/dev/null 2>&1; then   # T-0319: no service manager
    start_loop
    LOGHINT="tail -f ~/.chamber/agent.log"
    say "Done. The agent runs in the background, kept going by a small loop (this computer or phone has no service manager)."
    say "It does not start again by itself after a restart: run this again with --background then."
    "$ATT" || true
    say "Attach or remove folders any time: ~/.chamber/chamber-attach --help"
    say "See what it does: $LOGHINT"
    say "Stop it: curl -fsSL $URL/laptop.sh | sh -s -- --stop      Remove it: curl -fsSL $URL/laptop.sh | sh -s -- --uninstall"
    exit 0
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
      if ! { systemctl --user daemon-reload && systemctl --user enable --now chamber-agent; } >/dev/null 2>&1; then   # T-0319: no user service here after all (a container): the loop instead
        rm -f "$UNIT"; start_loop
        say "Done. This computer would not start a user service, so a small loop keeps the agent running. It does not start again by itself after a restart: run this again with --background then."
        say "See what it does: tail -f ~/.chamber/agent.log      Stop it: curl -fsSL $URL/laptop.sh | sh -s -- --stop"
        exit 0
      fi
    fi
    LOGHINT="journalctl --user -u chamber-agent -f"
  fi
  say "Done. The agent runs in the background and starts again when you log in."
  "$ATT" || true
  say "Attach or remove folders any time: ~/.chamber/chamber-attach --help"
  say "See what it does: $LOGHINT"
  say "Stop it: curl -fsSL $URL/laptop.sh | sh -s -- --stop      Remove it: curl -fsSL $URL/laptop.sh | sh -s -- --uninstall"
  exit 0
fi
"$ATT" || true
say "Attach or remove folders any time (in another terminal window): ~/.chamber/chamber-attach --help"
say "Starting the agent."
say "Leave this window open; Ctrl+C stops it. To keep it running after you close the window, run this again with --background."
if [ "$NOSTART" = 1 ]; then exit 0; fi
cd "$WORKDIR"
exec "$PY" "$DIR/chamber-agent.py" --env "$CONF"
