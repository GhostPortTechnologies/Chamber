#!/bin/bash
# Chamber one-command installer (T-0144). Installs a chat connector or a ticket worker on THIS machine and checks it works.
#
#   curl -fsSL https://chamber.ghostporttechnologies.com/install.sh | sudo bash -s -- --role connector --token chk_... --commanders you
#   curl -fsSL https://chamber.ghostporttechnologies.com/install.sh | sudo bash -s -- --role worker --token chk_... --repo /srv/app --service myapp
#
# Options (connector): --token chk_...  --commanders a,b  [--rooms general]  [--attach /path]  [--tools Read,Grep,Glob]
#         A new connector reads no file on this machine until you attach a folder (T-0218): --attach /path here (may be repeated), or
#         afterwards  sudo chamber-attach /path  (--remove, --private, --everything, --nothing, --help). One installed before this
#         keeps reading what its account can read; --reach attached switches it over, --reach all switches back.
#                      [--backend claude|ollama|openai|gemini] [--model NAME] [--llm-url URL] [--llm-key KEY]
#         (worker):    --token chk_...  --repo /path/to/live/git/repo  --service systemd-unit  [--health URL]  [--approvers a,b]  [--scope "what it owns"]  [--triage auto|strict|off]
#         (worker, pull requests instead of the live folder, T-0191): --mode pr --repo /path/to/a/clone --github-token TOKEN [--base main] [--parallel 1..5]
#         (both):      [--url https://chamber.example.com]  [--oauth-token sk-ant-oat01-...]  [--no-claude]  [--dry-run]  [--uninstall]
# The token is created in Chamber: Account -> AI agents -> Create token (or use the in-app "Add an agent" wizard, which writes this line for you).
# Re-running updates the scripts in place. Connector settings you do not pass again are kept as they are (T-0174), so
# adding the Claude sign-in later is just:  ... | sudo bash -s -- --role connector --oauth-token sk-ant-oat01-...
set -uo pipefail
URL=https://chamber.ghostporttechnologies.com; ROLE=""; TOKEN=""; COMMANDERS=""; ROOMS=""; WORKDIR=""; TOOLS=""   # T-0174: empty = "not given"; a re-run keeps what the settings file already says
ATTACH=(); REACH=""; BACKEND=""; MODEL=""; LLM_URL=""; LLM_KEY=""; REPO=""; SERVICE=""; HEALTH=""; APPROVERS=""; OAUTH=""; NO_CLAUDE=0; DRY=0; UNINSTALL=0; SCOPE=""; TRIAGE=""; WMODE=live; GHTOKEN=""; WBASE=""; WPAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE=$2; shift 2;; --token) TOKEN=$2; shift 2;; --commanders) COMMANDERS=$2; shift 2;; --rooms) ROOMS=$2; shift 2;;
    --workdir) WORKDIR=$2; ATTACH+=("$2"); shift 2;; --attach) ATTACH+=("$2"); shift 2;; --reach) REACH=$2; shift 2;; --tools) TOOLS=$2; shift 2;; --backend) BACKEND=$2; shift 2;; --model) MODEL=$2; shift 2;;
    --llm-url) LLM_URL=$2; shift 2;; --llm-key) LLM_KEY=$2; shift 2;; --repo) REPO=$2; shift 2;; --service) SERVICE=$2; shift 2;;
    --mode) WMODE=$2; shift 2;; --github-token) GHTOKEN=$2; shift 2;; --base) WBASE=$2; shift 2;; --parallel) WPAR=$2; shift 2;;   # T-0191/T-0192: worker pull-request mode
    --health) HEALTH=$2; shift 2;; --approvers) APPROVERS=$2; shift 2;; --scope) SCOPE=$2; shift 2;; --triage) TRIAGE=$2; shift 2;; --url) URL=${2%/}; shift 2;; --oauth-token) OAUTH=$2; shift 2;;
    --no-claude) NO_CLAUDE=1; shift;; --dry-run) DRY=1; shift;; --uninstall) UNINSTALL=1; shift;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null || echo "see the header of install.sh"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
red() { printf '\033[31m%s\033[0m\n' "$*"; }; yel() { printf '\033[33m%s\033[0m\n' "$*"; }; grn() { printf '\033[32m%s\033[0m\n' "$*"; }; say() { printf '[chamber-install] %s\n' "$*"; }
run() { if [ $DRY = 1 ]; then echo "  (dry) $*"; else "$@"; fi; }
[ "$(id -u)" = 0 ] || { red "Run me as root:  curl -fsSL $URL/install.sh | sudo bash -s -- <options>"; exit 1; }
case "$ROLE" in connector|worker) ;; *) red "--role connector or --role worker is required"; exit 2;; esac
case "$REACH" in ""|attached|all) ;; *) red "--reach is attached (the agent reads only what you attach) or all (whatever its account can read)"; exit 2;; esac
command -v python3 >/dev/null || { red "python3 is required"; exit 1; }
command -v curl >/dev/null || { red "curl is required"; exit 1; }
# T-0217: "--token -" (or no --token the first time) asks for the key on the terminal, so it is not left in this machine's command history.
ASK_KEY=0; if [ "$TOKEN" = "-" ]; then TOKEN=""; ASK_KEY=1; fi
if [ $UNINSTALL = 0 ] && [ $DRY = 0 ] && [ -z "$TOKEN" ] && { [ $ASK_KEY = 1 ] || ! grep -qs '^CHAMBER_TOKEN=chk_' "/etc/chamber-$( [ $ROLE = worker ] && echo worker || echo agent ).env"; }; then
  if (exec < /dev/tty) 2>/dev/null; then
    printf 'Paste the agent key from Chamber (it starts with chk_ and will not be shown), then press Enter: ' > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true; IFS= read -r TOKEN < /dev/tty || TOKEN=""; stty echo < /dev/tty 2>/dev/null || true; printf '\n' > /dev/tty
    TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
  fi
  case "$TOKEN" in chk_*) ;; *) red "An agent key is needed the first time (it starts with chk_). Run this in a terminal and paste the key when asked, or pass --token chk_... (Chamber -> gear menu -> Add an agent)."; exit 2;; esac
fi

if [ $ROLE = connector ]; then USER_=chamber-agent; OPT=/opt/chamber-agent; ENVF=/etc/chamber-agent.env; UNIT=chamber-agent; SRC=/agent/chamber-agent.py; SCRIPT=chamber-agent.py   # T-0174: was /source, which is the whole source archive, so step 3 failed for every new connector
else USER_=chamber-worker; OPT=/opt/chamber-worker; ENVF=/etc/chamber-worker.env; UNIT=chamber-worker; SRC=/worker; SCRIPT=chamber-worker.py
  case "$WMODE" in live|pr) ;; *) red "--mode is live (deploy into the live folder) or pr (pull requests on GitHub)"; exit 2;; esac
  if [ "$WMODE" = pr ]; then [ -n "$REPO" ] || [ $UNINSTALL = 1 ] || { red "pull-request mode needs --repo <a clone of the GitHub repository>"; exit 2; }
  else [ -n "$REPO" ] && [ -n "$SERVICE" ] || [ $UNINSTALL = 1 ] || { red "worker needs --repo <live git repo> and --service <systemd unit it may restart> (or --mode pr for pull requests)"; exit 2; }; fi
fi
HOMEDIR=/var/lib/$USER_

if [ $UNINSTALL = 1 ]; then
  say "removing $UNIT (the env file $ENVF and the user $USER_ are kept; delete them yourself if you want)"
  run systemctl disable --now $UNIT 2>/dev/null; run rm -f /etc/systemd/system/$UNIT.service /etc/sudoers.d/$USER_; run rm -rf $OPT; run systemctl daemon-reload
  grn "removed"; exit 0
fi

say "1/7 user $USER_"
id $USER_ >/dev/null 2>&1 || run useradd -r -m -d $HOMEDIR -s /usr/sbin/nologin $USER_
run install -d -o $USER_ -g $USER_ -m 750 $HOMEDIR

REPO_GROUP=""
if [ $ROLE = worker ]; then
  [ -d "$REPO/.git" ] || { red "$REPO is not a git repository"; exit 1; }
  REPO_GROUP=$(stat -c %G "$REPO"); [ "$REPO_GROUP" = root ] && REPO_GROUP=$USER_
  say "2/7 repo access: group $REPO_GROUP gets write on $REPO (root-owned files, secrets, *.db, backups/ stay as they are)"
  run usermod -aG $REPO_GROUP $USER_
  if [ $DRY = 0 ]; then
    # Only files not owned by root change group; root-owned files (cron scripts, etc.) are left alone on purpose.
    find "$REPO" -path "$REPO/backups" -prune -o ! -user root -exec chgrp "$REPO_GROUP" {} + 2>/dev/null
    find "$REPO" -path "$REPO/backups" -prune -o ! -user root ! -name '.env' ! -name '*.env' ! -name 'auth.json' ! -name 'stripe.json' ! -name '*.db' ! -name '*.db-*' ! -name '*.key' ! -name '*.pem' ! -name '*.sqlite*' -exec chmod g+w {} + 2>/dev/null
    find "$REPO" -path "$REPO/backups" -prune -o -type d -exec chmod g+s {} + 2>/dev/null
    [ -d "$REPO/backups" ] && { chgrp "$REPO_GROUP" "$REPO/backups"; chmod 3775 "$REPO/backups"; }   # worker may add backup dirs; sticky bit protects existing ones
    sudo -u "$(stat -c %U "$REPO")" git -C "$REPO" config core.sharedRepository group 2>/dev/null || true
    sudo -u $USER_ -H git config --global --add safe.directory "$REPO" 2>/dev/null || true
  fi
else say "2/7 (connector: no repo access needed)"; fi

say "3/7 scripts into $OPT"
run install -d -m 755 $OPT
if [ $DRY = 0 ]; then curl -fsSL "$URL$SRC" -o $OPT/$SCRIPT.new || { red "could not download $URL$SRC"; exit 1; }
  python3 -m py_compile $OPT/$SCRIPT.new || { red "downloaded $SCRIPT does not compile"; exit 1; }; mv $OPT/$SCRIPT.new $OPT/$SCRIPT; chmod 755 $OPT/$SCRIPT; fi

say "4/7 settings $ENVF (root:$USER_, 0640)"
if [ $DRY = 0 ]; then
  OLD_TOKEN=$(grep -s '^CHAMBER_TOKEN=' $ENVF | cut -d= -f2-); OLD_OAUTH=$(grep -s '^CLAUDE_CODE_OAUTH_TOKEN=' $ENVF | cut -d= -f2-)
  TOKEN=${TOKEN:-$OLD_TOKEN}; OAUTH=${OAUTH:-$OLD_OAUTH}
  old() { grep -s "^$1=" $ENVF | head -1 | cut -d= -f2-; }                    # T-0174: a re-run must not wipe settings it was not given
  NEWINSTALL=1; [ -f $ENVF ] && NEWINSTALL=0
  # T-0218: a new connector reads only what is attached. One installed before keeps how it worked unless --reach says otherwise.
  REACH=${REACH:-$(old CHAMBER_REACH)}; [ $NEWINSTALL = 1 ] && REACH=${REACH:-attached}
  if [ $ROLE = connector ]; then COMMANDERS=${COMMANDERS:-$(old CHAMBER_COMMANDERS)}; ROOMS=${ROOMS:-$(old CHAMBER_ROOMS)}; WORKDIR=${WORKDIR:-$(old CHAMBER_WORKDIR)}; TOOLS=${TOOLS:-$(old CHAMBER_ALLOWED_TOOLS)}
    MODEL=${MODEL:-$(old CHAMBER_MODEL)}; BACKEND=${BACKEND:-$(old CHAMBER_BACKEND)}; LLM_URL=${LLM_URL:-$(old CHAMBER_LLM_URL)}; LLM_KEY=${LLM_KEY:-$(old CHAMBER_LLM_KEY)}; fi
  ROOMS=${ROOMS:-general}; TOOLS=${TOOLS:-Read,Grep,Glob}; BACKEND=${BACKEND:-claude}
  { echo "# written by $URL/install.sh on $(date -u +%FT%TZ); re-run the installer to change settings"
    echo "CHAMBER_URL=$URL"; echo "CHAMBER_TOKEN=$TOKEN"
    if [ $ROLE = connector ]; then
      echo "CHAMBER_COMMANDERS=$COMMANDERS"; echo "CHAMBER_ROOMS=$ROOMS"; echo "CHAMBER_WORKDIR=${WORKDIR:-$HOMEDIR/work}"; echo "CHAMBER_ALLOWED_TOOLS=$TOOLS"
      [ -n "$REACH" ] && echo "CHAMBER_REACH=$REACH"                                        # T-0218
      echo "CHAMBER_ATTACHED_FILE=/etc/chamber-agent.attached.json"; echo "CHAMBER_ATTACH_HINT=sudo chamber-attach <folder>"
      # Lines someone added by hand (CHAMBER_DENY_PATHS, CHAMBER_ASK_TOOLS, CHAMBER_GIT_REPO, ...) survive a re-run; the ones this installer writes itself do not come twice.
      grep -sE '^[A-Z_][A-Z0-9_]*=' $ENVF | while IFS= read -r L; do case " CHAMBER_URL CHAMBER_TOKEN CHAMBER_COMMANDERS CHAMBER_ROOMS CHAMBER_WORKDIR CHAMBER_ALLOWED_TOOLS CHAMBER_MODEL CHAMBER_BACKEND CHAMBER_LLM_URL CHAMBER_LLM_KEY CLAUDE_CODE_OAUTH_TOKEN CHAMBER_REACH CHAMBER_ATTACHED_FILE CHAMBER_ATTACH_HINT " in *" ${L%%=*} "*) ;; *) echo "$L";; esac; done
      [ -n "$MODEL" ] && echo "CHAMBER_MODEL=$MODEL"   # 3.16.1: for Claude too (e.g. claude-opus-5-5)
      [ "$BACKEND" != claude ] && { echo "CHAMBER_BACKEND=$BACKEND"; [ -n "$LLM_URL" ] && echo "CHAMBER_LLM_URL=$LLM_URL"; [ -n "$LLM_KEY" ] && echo "CHAMBER_LLM_KEY=$LLM_KEY"; }
    else echo "WORKER_REPO=$REPO"; echo "WORKER_SERVICE=$SERVICE"; echo "WORKER_HEALTH=$HEALTH"; echo "WORKER_APPROVERS=${APPROVERS:-$COMMANDERS}"
      echo "WORKER_MODE=$WMODE"; [ -n "$GHTOKEN" ] && echo "WORKER_GITHUB_TOKEN=$GHTOKEN"; [ -n "$WBASE" ] && echo "WORKER_BASE=$WBASE"; [ -n "$WPAR" ] && echo "WORKER_PARALLEL=$WPAR"   # T-0191/T-0192
      [ -n "$SCOPE" ] && echo "WORKER_SCOPE=$SCOPE"; [ -n "$TRIAGE" ] && echo "WORKER_TRIAGE=$TRIAGE"; fi   # T-0151: triage settings (defaults: auto, scope from the file list)
    [ -n "$OAUTH" ] && echo "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH"
  } > $ENVF.new; chown root:$USER_ $ENVF.new; chmod 0640 $ENVF.new; mv $ENVF.new $ENVF
  [ $ROLE = connector ] && install -d -o $USER_ -g $USER_ ${WORKDIR:-$HOMEDIR/work} 2>/dev/null || true
  if [ $ROLE = connector ]; then
    # T-0218: the list of what the agent may read. Root owns it, so the agent's own account can read the list and never change it.
    [ -f /etc/chamber-agent.attached.json ] || echo '{"paths": [], "private": [], "all": false}' > /etc/chamber-agent.attached.json
    chown root:$USER_ /etc/chamber-agent.attached.json; chmod 0640 /etc/chamber-agent.attached.json
    cat > /usr/local/bin/chamber-attach <<'AT'
#!/bin/sh
# chamber-attach (T-0218): choose what the Chamber agent on this machine can read. Written by install.sh.
#   sudo chamber-attach                   show what is attached        sudo chamber-attach FOLDER-OR-FILE ...   attach it
#   sudo chamber-attach --remove PATH     take it away again           sudo chamber-attach --private PATH       for your eyes only
#   sudo chamber-attach --unprivate PATH  --everything  --nothing  --help
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
CHAMBER_ATTACH_AS=chamber-agent; export CHAMBER_ATTACH_AS
exec python3 /opt/chamber-agent/chamber-agent.py --env /etc/chamber-agent.env --attach "$@"
AT
    chmod 755 /usr/local/bin/chamber-attach
    if [ $NEWINSTALL = 1 ] || [ "$REACH" = attached ]; then for A in ${ATTACH[@]+"${ATTACH[@]}"}; do OUT=$(/usr/local/bin/chamber-attach "$A" 2>&1) || red "    could not attach $A: $OUT"; grep -A1 '^Note: the agent runs as' <<<"$OUT" | sed 's/^/    /'; done; fi
  fi
fi

say "5/7 service $UNIT"
if [ $ROLE = worker ]; then
  if [ "$WMODE" = pr ]; then run rm -f /etc/sudoers.d/chamber-worker   # T-0191: pull-request mode restarts nothing, so it gets no root right at all
  else run bash -c "printf '%s\n' '# chamber-worker: the ONLY root action it may take (restart the service it deploys).' 'chamber-worker ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE' > /etc/sudoers.d/chamber-worker && chmod 0440 /etc/sudoers.d/chamber-worker && visudo -cf /etc/sudoers.d/chamber-worker >/dev/null"; fi
  if [ $DRY = 0 ]; then curl -fsSL "$URL/worker.service" | sed "s|__REPO_GROUP__|$REPO_GROUP|; s|__REPO__|$REPO|" > /etc/systemd/system/$UNIT.service; fi
else
  if [ $DRY = 0 ]; then curl -fsSL "$URL/agent.service" -o /etc/systemd/system/$UNIT.service.new || { red "could not download the unit file"; exit 1; }
    # T-0174: the template says User=CHANGE_ME and /home/CHANGE_ME; fill in the account made in step 1 (the service could not start before)
    sed -i "s|/home/CHANGE_ME|$HOMEDIR|g; s|CHANGE_ME|$USER_|g" /etc/systemd/system/$UNIT.service.new; grep -q "^Environment=HOME=" /etc/systemd/system/$UNIT.service.new || sed -i "s|^WorkingDirectory=.*|&\nEnvironment=HOME=$HOMEDIR|" /etc/systemd/system/$UNIT.service.new
    mv /etc/systemd/system/$UNIT.service.new /etc/systemd/system/$UNIT.service; fi
fi
if [ $DRY = 0 ] && [ $NO_CLAUDE = 0 ] && [ "$BACKEND" = claude ]; then
  if ! sudo -u $USER_ -H $HOMEDIR/.local/bin/claude --version >/dev/null 2>&1; then say "    installing the Claude Code CLI for $USER_"; sudo -u $USER_ -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1 || red "    claude CLI install failed (the service still starts; install it later)"; fi
fi
if [ $ROLE = worker ] && [ $DRY = 0 ]; then python3 -c 'import pytest' 2>/dev/null || { (apt-get install -y -q python3-pytest || dnf install -y -q python3-pytest || pip3 install -q pytest) >/dev/null 2>&1 || true; }; fi
run systemctl daemon-reload; run systemctl enable --now $UNIT
[ $DRY = 1 ] && { grn "dry run complete, nothing changed"; exit 0; }

say "6/7 self-check"
FAILS=0; SIGNIN=0; ck() { if [ "$2" = 0 ]; then grn "  PASS  $1"; else red "  FAIL  $1  $3"; FAILS=$((FAILS+1)); fi; }
sleep 3; systemctl is-active --quiet $UNIT; ck "service $UNIT is running" $? "see: journalctl -u $UNIT -n 30"
TOKEN=$(grep '^CHAMBER_TOKEN=' $ENVF | cut -d= -f2-)
ME=$(curl -s -m 10 -H "Authorization: Bearer $TOKEN" "$URL/api/me" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("username",""))' 2>/dev/null); [ -n "$ME" ]; ck "token accepted by $URL (agent name: ${ME:-?})" $? "token wrong or revoked"
if [ "$BACKEND" = claude ] && [ $NO_CLAUDE = 0 ]; then V=$(sudo -u $USER_ -H $HOMEDIR/.local/bin/claude --version 2>/dev/null | head -1); [ -n "$V" ]; ck "claude CLI works as $USER_ ($V)" $? "install it: sudo -u $USER_ -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash'"
  if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' $ENVF; then grn "  PASS  Claude sign-in is in $ENVF"; else SIGNIN=1; yel "  TO DO Claude sign-in (one step left, see below)"; fi; fi
if [ $ROLE = worker ]; then sudo -u $USER_ test -w "$REPO" && sudo -u $USER_ git -C "$REPO" status --short >/dev/null 2>&1; ck "$USER_ can write and run git in $REPO" $? "check group write on the repo"; fi
ONLINE=1; for i in $(seq 1 15); do curl -s -m 8 -H "Authorization: Bearer $TOKEN" "$URL/api/presence" | grep -q "\"username\": *\"$ME\"" && { ONLINE=0; break; }; sleep 3; done; ck "$ME shows up in Chamber's People & agents" $ONLINE "it has not pinged yet; check the service log"
if [ $ROLE = connector ]; then say "    what ${ME:-the agent} can read on this machine (change it any time: sudo chamber-attach --help)"; /usr/local/bin/chamber-attach 2>&1 | sed 's/^/      /'; fi   # T-0218
say "7/7 hello"
if [ -n "$ME" ]; then curl -s -m 10 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"username\":\"$ME\",\"room\":\"${ROOMS%%,*}\",\"type\":\"status\",\"text\":\"installed on $(hostname) as a $ROLE by $URL/install.sh\"}" "$URL/api/messages" >/dev/null && grn "  posted 'installed on $(hostname)' to #${ROOMS%%,*}"; fi
if [ $FAILS = 0 ] && [ $SIGNIN = 1 ]; then                                   # T-0174: not a failure, and said in a way a new person can follow
  yel "INSTALLED. ONE STEP LEFT: sign your AI in, so ${ME:-it} can answer. Two commands on this machine:"
  echo "  1) sudo -u $USER_ -H $HOMEDIR/.local/bin/claude setup-token"
  echo "       It shows a link. Open it, log in with your own Claude account, and it prints a long code starting sk-ant-oat01-"
  echo "  2) curl -fsSL $URL/install.sh | sudo bash -s -- --role $ROLE$( [ "$URL" != https://chamber.ghostporttechnologies.com ] && echo " --url $URL" )$( [ $ROLE = worker ] && echo " --repo $REPO --service $SERVICE" ) --oauth-token PASTE-THE-CODE-HERE"
  echo "  The code stays in $ENVF on this machine. Chamber never sees it. Everything else you set is kept."
  exit 0
fi
if [ $FAILS = 0 ]; then grn "ALL CHECKS PASSED. $( [ $ROLE = connector ] && echo "Mention @$ME in #${ROOMS%%,*} from a commander account to test it." || echo "Approve an [agent] ticket and watch #${ROOMS%%,*} for Starting -> Done." )"; else red "$FAILS check(s) failed; see above. Logs: journalctl -u $UNIT -n 30 --no-pager"; exit 1; fi
