#!/usr/bin/env python3
"""chamber-worker: act on Chamber tickets that a person approved.

Loop: find approved tickets whose title starts with [agent] -> claim -> let a locked Claude
session make the change in a git worktree on branch chamber/<ticket> -> run tests -> deploy the
changed files into the live tree with backups -> restart the service -> health check -> roll
back on any failure -> close/update the ticket and post the result to #general.

Hard rules, enforced here and not by the model:
  * only tickets approved by someone in WORKER_APPROVERS (required: there is no default)
  * one ticket at a time, WORKER_TIMEOUT seconds per ticket (default 1200)
  * changes touching a denylisted path (keys, tokens, env files, databases, backups, /etc) are never deployed
  * nothing is deployed if py_compile or pytest fails
  * every live file replaced is backed up first; any failure after that restores the backups

Config (env, normally /etc/chamber-worker.env):
  CHAMBER_URL, CHAMBER_TOKEN        Chamber API (its own agent token, name chamber-worker)
  WORKER_REPO=/srv/myapp            git repo that IS the live tree (required)
  WORKER_SERVICE=myapp              systemd unit to restart after deploy (required)
  WORKER_HEALTH=http://127.0.0.1:8000/health   optional URL that must answer 200 within 60s
  WORKER_ROOM=general               where results are posted
  WORKER_APPROVERS=your-username    comma-separated (required)
  WORKER_DENY=secrets/*,*.pfx       optional: more path patterns that must never be deployed, comma-separated (1.5.1)
  WORKER_CLAUDE=/var/lib/chamber-worker/.local/bin/claude
  WORKER_SCOPE="what this worker owns"   one line used by triage, e.g. "the shop API and its deploy scripts"
  WORKER_TRIAGE=strict                   strict (default since 1.5.0): leave a ticket alone unless it is clearly for this repo;
                                         auto: also try when unsure;  off: claim every approved agent ticket (pre-1.3 behaviour)
                                         1.5.0 (T-0164): the room only hears Done / FAILED / BLOCKED. Taking a ticket, leaving one
                                         alone, or handing one back is written to the ticket's run log, not posted as chat.
  WORKER_TRIAGE_MODEL=claude-haiku-5-5   cheap model for the one-line triage question (no tools, ~10 s)

Triage (1.3.0): before claiming, the worker checks the ticket is for THIS repo at all. Rules first ([worker:name] in the
title, file paths that do or do not exist here), then one tool-less question to a cheap model. A ticket that is not for
this worker is never claimed: a run-log line says why, and if no other worker is online the approver is told in the room.
A ticket that fails after claiming is RELEASED (back to approved, unassigned) with the reason, never left in progress.
Standing approvals (1.8.0, T-0200): a ticket a person approved in advance (ticket.standing) is taken only by the agent it names
and only in pull-request mode; before pushing, Chamber checks the changed files against its limits. A refused claim stops the work.
"""
import os, re, sys, json, time, shutil, subprocess, urllib.request, urllib.error, urllib.parse, fnmatch, base64, threading

URL = os.environ.get("CHAMBER_URL", "https://chamber.ghostporttechnologies.com").rstrip("/")
TOKEN = os.environ.get("CHAMBER_TOKEN", "")
ME = os.environ.get("CHAMBER_AGENT_NAME", "chamber-worker")
REPO = os.environ.get("WORKER_REPO", "")                                 # 1.5.1: no built-in defaults; the installer writes all three
SERVICE = os.environ.get("WORKER_SERVICE", "")
HEALTH = os.environ.get("WORKER_HEALTH", "")
ROOM = os.environ.get("WORKER_ROOM", "general")
APPROVERS = {a.strip() for a in os.environ.get("WORKER_APPROVERS", "").split(",") if a.strip()}
CLAUDE = os.environ.get("WORKER_CLAUDE", os.path.expanduser("~/.local/bin/claude"))
TIMEOUT = int(os.environ.get("WORKER_TIMEOUT", "1200"))
SCOPE = os.environ.get("WORKER_SCOPE", "").strip()                      # 1.3.0: one line, what this worker owns
TRIAGE = os.environ.get("WORKER_TRIAGE", "strict").strip().lower()      # strict (default since 1.5.0, T-0164) | auto | off
TRIAGE_MODEL = os.environ.get("WORKER_TRIAGE_MODEL", "claude-haiku-5-5")
HOME = os.environ.get("WORKER_HOME", "/var/lib/chamber-worker")
WORK = os.path.join(HOME, "work")
STATE = os.path.join(HOME, "state.json")
DENY = ["*.key", "*.pub", "*.pem", "auth.json", "*tokens*", "*secret*", "*credential*", "*.env", "backups/*", "*.db", "*.sqlite*"] + \
       [p.strip() for p in os.environ.get("WORKER_DENY", "").split(",") if p.strip()]      # 1.5.1: add your own never-deploy patterns
TOOLS = ["Read", "Edit", "Write", "Grep", "Glob", "Bash(python3 -m pytest:*)", "Bash(python3 -m py_compile:*)",
         "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)"]

# 1.7.0 (T-0191, T-0192): pull-request mode. WORKER_MODE=pr: an approved ticket becomes a branch and a GitHub pull request; nothing
# is deployed and nothing is restarted, so no WORKER_SERVICE and no sudo right are needed. Merging the pull request closes the
# ticket; closing it unmerged hands the ticket back. Only in this mode the worker may run up to WORKER_PARALLEL (1..5) tickets at
# once, each in its own worktree. Live mode stays one at a time on purpose: two jobs changing a running server at once is how
# things break.
MODE = os.environ.get("WORKER_MODE", "live").strip().lower()
GH_TOKEN = os.environ.get("WORKER_GITHUB_TOKEN", "").strip()            # needs: Contents read/write + Pull requests read/write on that repo
GH_API = os.environ.get("WORKER_GITHUB_API", "https://api.github.com").rstrip("/")
GH_REPO = os.environ.get("WORKER_GITHUB_REPO", "").strip()              # owner/name; empty = read from the repo's origin
BASE = os.environ.get("WORKER_BASE", "").strip()                        # branch pull requests go into; empty = the repo's current branch
try: PARALLEL = max(1, min(5, int(os.environ.get("WORKER_PARALLEL", "1")))) if MODE == "pr" else 1
except ValueError: PARALLEL = 1
REPO_LOCK, STATE_LOCK = threading.Lock(), threading.Lock()              # repo-wide git steps (worktree add/remove, fetch, push) one at a time

if not TOKEN:
    sys.exit("CHAMBER_TOKEN is required")
if MODE not in ("live", "pr"):
    sys.exit("WORKER_MODE must be live (deploy into the live folder) or pr (pull requests)")
_missing = [n for n, v in (("WORKER_REPO", REPO), ("WORKER_APPROVERS", APPROVERS)) + ((("WORKER_SERVICE", SERVICE),) if MODE == "live" else (("WORKER_GITHUB_TOKEN", GH_TOKEN),)) if not v]
if _missing:
    sys.exit(", ".join(_missing) + " must be set (the installer writes them to /etc/chamber-worker.env); there are no built-in defaults")


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def say(text):
    try: api("POST", "/api/messages", {"username": ME, "text": text[:1500], "room": ROOM, "type": "message"})
    except Exception as e: log(f"say failed: {e}")


def ticket(verb, tid, **kw):
    """POST a ticket verb; True on success (1.3.0: callers fall back when the server refuses, e.g. an older Chamber on release)."""
    try: api("POST", f"/api/tickets/{tid}/{verb}", {"by": ME, **kw}); return True
    except Exception as e: log(f"ticket {verb} {tid} failed: {e}"); return False


def claim(tid):
    """1.8.0: claim a ticket, telling Chamber this worker's mode; (True, '') or (False, why Chamber said no). Before 1.8.0 a
    refused claim (the AI budget used up, for example) was only logged and the work went ahead anyway."""
    try: api("POST", f"/api/tickets/{tid}/claim", {"by": ME, "mode": MODE}); return True, ""
    except urllib.error.HTTPError as e:
        try: why = json.loads(e.read().decode("utf-8", "replace") or "{}").get("error") or str(e)
        except Exception: why = str(e)
        return False, f"{e.code}: {why}"
    except Exception as e: return False, str(e)


def log(msg): print(time.strftime("%H:%M:%S"), msg, flush=True)


def load_state():
    try: return json.load(open(STATE))
    except Exception: return {"done": {}}


def save_state(st):
    os.makedirs(HOME, exist_ok=True)
    json.dump(st, open(STATE + ".tmp", "w")); os.replace(STATE + ".tmp", STATE)


def run(cmd, cwd=None, timeout=600, env=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
    return p.returncode, (p.stdout + p.stderr)[-4000:]


def git(*a, cwd=REPO): return run(["git", *a], cwd=cwd)


JUNK = (":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/*.pyc", ":(exclude,glob)**/.pytest_cache/**")   # 1.8.0: what py_compile and pytest leave behind is never part of a change
def junk(p): parts = p.rstrip("/").split("/"); return "__pycache__" in parts or ".pytest_cache" in parts or p.endswith(".pyc")
def denied(path): return any(fnmatch.fnmatch(path, pat) for pat in DENY) or path.startswith("/")


def health_ok():
    for _ in range(30):
        time.sleep(2)
        rc, _ = run(["systemctl", "is-active", "--quiet", SERVICE])
        if rc != 0: continue
        if not HEALTH: return True
        try:
            with urllib.request.urlopen(HEALTH, timeout=5) as r:
                if r.status == 200: return True
        except Exception: pass
    return False


WORKER_VERSION = "worker-1.8.0"


def wlog(tid, line, model=None):
    """T-0143: one run-log line on the ticket (shown live in the ticket modal); optionally also the model name."""
    kw = {"line": line}
    if model: kw["model"] = model
    ticket("log", tid, **kw)


def parse_claude_json(out):
    """1.6.0 (T-0194): `claude -p --output-format json` prints one JSON object with the closing text and what the run cost.
    Returns (text, usage or None); an older CLI that printed plain text gives (that text, None)."""
    s = (out or "").strip()
    o = None
    for cand in (s, s.splitlines()[-1] if s else ""):
        try: o = json.loads(cand); break
        except ValueError: continue
    if not isinstance(o, dict): return out or "", None
    u = o.get("usage") or {}
    usage = {"tokens_in": int((u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)),
             "tokens_out": int(u.get("output_tokens") or 0), "ms": int(o.get("duration_ms") or 0)}
    if isinstance(o.get("total_cost_usd"), (int, float)): usage["cost_cents"] = round(o["total_cost_usd"] * 100, 2)
    return str(o.get("result") or ""), usage


def tail_summary(text, limit=900):
    """The model's closing summary, whole lines only (1.3.2: no more sentences cut in half in Done lines and run logs)."""
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    out = []
    for l in reversed(lines[-8:]):
        if sum(len(x) + 1 for x in out) + len(l) > limit: break
        out.insert(0, l)
    return " ".join(out) if out else (lines[-1][:limit] if lines else "")


def model_used(wt):
    """Which model the CLI used in this worktree: read from the newest Claude Code transcript under HOME/.claude/projects."""
    import glob
    d = os.path.join(HOME, ".claude", "projects", wt.replace("/", "-"))
    try:
        files = sorted(glob.glob(os.path.join(d, "*.jsonl")), key=os.path.getmtime)
        for line in open(files[-1]):
            try: j = json.loads(line)
            except Exception: continue
            if j.get("type") == "assistant" and (j.get("message") or {}).get("model"): return j["message"]["model"]
    except Exception: pass
    return None


# ── Triage (worker-1.3.0, T-0151). Decide BEFORE claiming whether a ticket is for this worker at all. T-0150 showed the
# failure mode: a ticket for code on another box was claimed, the model found nothing to change, and the ticket sat in
# progress on the worker until a person noticed. Rules first (free, deterministic), then one short tool-less question to a
# cheap model when the rules cannot tell. The verdict is written to the ticket's run log either way.
PATH_RE = re.compile(r"(?<![\w.@/-])((?:/|[\w.-]+/)(?:[\w./-]*\w)?|[\w-]+\.(?:py|js|ts|html|css|sh|md|json|ya?ml|service|conf|toml|txt|sql|go|rs|java|rb|php))(?![\w/])")   # a bare "sops/" counts too
ADDR_RE = re.compile(r"\[worker:([\w.-]+)\]", re.I)      # "[worker:shop-worker] fix the cart" routes a ticket to one named worker


def repo_inventory(limit=400):
    rc, out = git("ls-files")
    return [l.strip() for l in out.splitlines() if l.strip()][:limit] if rc == 0 else []


def paths_in(text):
    """File-ish tokens in a ticket (paths with a slash, or names with a code/config extension); URLs are ignored."""
    seen = []
    for m in PATH_RE.finditer(re.sub(r"https?://\S+", " ", text or "")):
        p = m.group(1).strip("/.")
        if p and p.lower() not in ("e.g", "i.e") and p not in seen: seen.append(p)
    return seen


def known_in_repo(p, inv):
    p = p.lower(); base = p.rsplit("/", 1)[-1]
    if p.startswith(REPO.lower().strip("/")): return True                     # an absolute path inside the live tree
    for f in inv:
        fl = f.lower()
        if fl == p or fl.endswith("/" + p) or fl.startswith(p + "/") or fl.rsplit("/", 1)[-1] == base: return True
    return False


def triage_rules(t, inv):
    """(verdict, why) with verdict in {'in', 'out', None}; None = the rules cannot tell."""
    title = t.get("title", "") or ""; text = title + "\n" + (t.get("body", "") or "")
    m = ADDR_RE.search(title)
    if m:
        who = m.group(1)
        return ("in", f"addressed to {ME}") if who.lower() == ME.lower() else ("out", f"addressed to worker '{who}'")
    paths = paths_in(text)
    known = [p for p in paths if known_in_repo(p, inv)]
    on_disk = [p for p in paths if p not in known and os.path.exists(os.path.join(REPO, p))]
    if on_disk: return "out", (f"{on_disk[0]} exists in {REPO} but is not committed to git, so my worktree (built from the last commit) cannot see it; "
                               f"commit it there (git add + git commit), then add a note to this ticket and I will look again")
    unknown = [p for p in paths if p not in known]
    if known: return "in", "names files in this repo: " + ", ".join(known[:3])
    if len(unknown) >= 2: return "out", "names files this repo does not have: " + ", ".join(unknown[:3])
    return None, ""


def parse_triage(out):
    for line in (out or "").splitlines():
        m = re.match(r"\**(IN|OUT|UNSURE)\**\s*[:\-]\s*(.*)", line.strip(), re.I)
        if m: return m.group(1).lower(), m.group(2).strip()[:300]
    return "unsure", "triage answer not understood: " + (out or "")[:120]


def triage_model(t, inv):
    """One short, tool-less question to a cheap model. (verdict, why); 'unsure' on any problem."""
    if not os.path.exists(CLAUDE): return "unsure", "no model available for triage"
    prompt = (f"You are the triage step of {ME}, a ticket worker that can only change files inside ONE git repository on THIS machine.\n"
              f"Repository: {REPO}. Scope: {SCOPE or 'not described; judge from the file list'}.\n"
              f"Files in it (first {min(len(inv), 300)}): {' '.join(inv[:300])}\n\n"
              f"Ticket {t.get('id', '?')}: {t.get('title', '')}\n{(t.get('body', '') or '')[:3000]}\n\n"
              "Can this ticket be completed by editing files in this repository only? Answer with exactly one line and nothing else:\n"
              "IN: <which files here it touches>   or   OUT: <where that code most likely lives instead>   or   UNSURE: <why>")
    env = {k: v for k, v in os.environ.items() if k != "CHAMBER_TOKEN"}; env["HOME"] = HOME
    try:
        p = subprocess.run([CLAUDE, "-p", prompt, "--model", TRIAGE_MODEL, "--output-format", "text", "--tools", "", "--max-turns", "1",
                            "--permission-mode", "dontAsk"], cwd=REPO, capture_output=True, text=True, timeout=120, env=env, stdin=subprocess.DEVNULL)
    except Exception as e: return "unsure", f"triage model failed: {e!r}"
    if p.returncode: return "unsure", f"triage model rc={p.returncode}: {(p.stdout + p.stderr).strip()[-200:]}"
    return parse_triage(p.stdout)


def triage(t):
    """(verdict, why): 'in' = claim it; 'out' = leave it approved and unclaimed for whoever owns that code."""
    if TRIAGE == "off": return "in", "triage off"
    inv = repo_inventory()
    v, why = triage_rules(t, inv)
    if v is None: v, why = triage_model(t, inv)
    if v == "unsure": return ("in", f"unsure, trying anyway (WORKER_TRIAGE=auto): {why}") if TRIAGE == "auto" else ("out", f"unsure, so leaving it alone: {why}")
    return v, why


def user_roles():
    """{username(lower): role} for the workspace, from presence (one call per poll). Empty on error = count every note."""
    try: return {str(u.get("username") or "").lower(): u.get("role") for u in api("GET", "/api/presence").get("presence", [])}
    except Exception: return {}


def ticket_for(t):
    """'agent' | 'human' | None. 1.4.0 (T-0155): Chamber marks every ticket with who does it; the title tag is only a fallback."""
    f = t.get("for")
    if f in ("agent", "human"): return f
    title = (t.get("title") or "").lower()
    return "agent" if "[agent]" in title else ("human" if "[human]" in title else None)


def retry_key(t, roles=None):
    """Done-state key. Counts ticket notes written by PEOPLE: when a person adds a note, the ticket gets a fresh key and is
    looked at again (retry after they fixed the cause). Notes by me or by other agents (1.3.3) never re-arm it."""
    roles = roles or {}
    n = sum(1 for u in (t.get("updates") or []) if str(u.get("by") or "").lower() != ME.lower() and roles.get(str(u.get("by") or "").lower()) != "ai")
    return f"{t.get('id', '')}@{n}"


def who_else(t):
    """(other workers online, proposer is an agent). Other workers = a version line starting with worker-. If the ticket
    was proposed by an agent (e.g. a chat connector filing product work for itself), that agent owns it: no room post."""
    try: pres = api("GET", "/api/presence").get("presence", [])
    except Exception: return [], False
    others = [u.get("username") for u in pres if u.get("username") != ME and str(((u.get("agent") or {}).get("version")) or "").startswith("worker-")]
    prop = str(t.get("proposed_by") or "").lower()
    proposer_ai = any(str(u.get("username") or "").lower() == prop and u.get("role") == "ai" for u in pres)
    return others, proposer_ai


def presence(state, tid=None):
    """T-0143: tell Chamber what the worker is doing (sidebar shows 'working in #room - T-xxxx')."""
    b = {"username": ME, "version": WORKER_VERSION, "rooms": [ROOM], "state": state}
    if tid: b["room"] = ROOM; b["task"] = tid
    try: api("POST", "/api/ping", b)
    except Exception as e: log(f"ping failed: {e}")


def work(t):
    tid, title, body = t["id"], t.get("title", ""), t.get("body", "")
    wt = os.path.join(WORK, tid); branch = f"chamber/{tid}"
    ok_c, why_c = claim(tid)                            # 1.8.0: a refused claim stops here; nothing is changed
    if not ok_c: return False, f"claim refused: {why_c}"
    log(f"starting {tid}: {title}")                    # 1.5.0 (T-0164): no chat message; presence shows it working and the run log has the steps
    presence("working", tid); wlog(tid, "claimed; creating worktree and starting the model session")
    rc, out = git("worktree", "add", "-B", branch, wt, "HEAD")
    if rc: return False, f"could not create worktree: {out}"
    try:
        prompt = (f"You are chamber-worker making the change described by Chamber ticket {tid}.\n"
                  f"TITLE: {title}\n\nBODY:\n{body}\n\n"
                  "Rules: work only inside the current directory (a git worktree of the live repo). Make the smallest "
                  "correct change. Never touch keys, password or token files, databases or anything under backups/. "
                  "Run python3 -m py_compile on every .py you change and python3 -m pytest -q if tests exist. "
                  "Finish with a 3-line summary: what changed, how you tested it, what to watch after deploy.\n"
                  f"This worktree is the repository at {REPO}. If the ticket asks for a change to code "
                  "that is not in this repo (for example another project, or something on another machine), change "
                  "nothing and reply with exactly one line: CANNOT: <where the code actually lives and why you cannot do it here>.")
        env = {k: v for k, v in os.environ.items() if k not in ("CHAMBER_TOKEN", "WORKER_GITHUB_TOKEN")}   # 1.7.0: the model never sees the GitHub key
        env["HOME"] = HOME
        base = sorted({x.split("(")[0] for x in TOOLS})
        cmd = [CLAUDE, "-p", prompt, "--output-format", "json", "--tools", *base, "--allowedTools", *TOOLS,
               "--permission-mode", "dontAsk", "--max-turns", "60"]
        try:
            p = subprocess.run(cmd, cwd=wt, capture_output=True, text=True, timeout=TIMEOUT, env=env); rc = p.returncode
            summary, usage = parse_claude_json(p.stdout)                 # 1.6.0 (T-0194): the closing text and what the run cost
            if rc and not summary.strip(): summary = (p.stdout + p.stderr)[-4000:]
        except subprocess.TimeoutExpired: return False, f"model session exceeded {TIMEOUT}s; nothing deployed"
        if usage: ticket("log", tid, usage=usage)                       # the usage page counts it on this ticket
        if rc: return False, f"model session failed (rc={rc}): {summary[-800:]}"
        rc, changed = git("status", "--porcelain", cwd=wt)
        files = [l[3:].strip() for l in changed.splitlines() if l.strip() and not junk(l[3:].strip())]
        tail = tail_summary(summary, 600)                  # T-0151: never discard the model's own explanation
        wlog(tid, f"model session finished (rc={rc}); {len(files)} file(s) changed: {', '.join(files[:8])}. Model said: {tail}", model=model_used(wt))
        if not files:
            if "CANNOT:" in summary:
                reason = summary.split("CANNOT:", 1)[1].strip().splitlines()[0][:400]
                return False, f"out of scope for this worker: {reason}. If a person should do it, open the ticket and switch it to 'A person'; if it is for code on another machine, add a worker there."
            return False, f"model made no file changes; nothing deployed. Model said: {tail}"
        bad = [f for f in files if denied(f)]
        if bad: return False, f"refused: change touches protected paths {bad}; nothing deployed"
        rc_d, dirty = git("status", "--porcelain", "--", *files)                   # 1.3.1: my worktree is built from the last commit;
        if rc_d == 0 and dirty.strip():                                              # deploying over an uncommitted live edit would silently undo it
            return False, (f"blocked: the live copy of {', '.join(sorted({l[3:].strip() for l in dirty.splitlines() if l.strip()}))} in {REPO} has uncommitted changes, "
                           "so deploying my version would overwrite them. Commit the live tree first (git add + git commit), then add a note to this ticket and I will retry.")
        for f in files:
            if f.endswith(".py"):
                rc, out = run(["python3", "-m", "py_compile", f], cwd=wt)
                if rc: return False, f"py_compile failed on {f}: {out[-600:]}; nothing deployed"
        if any(fn.startswith("test_") for fn in os.listdir(wt)):
            rc, out = run(["python3", "-m", "pytest", "-q", "-x"], cwd=wt, timeout=600)
            # rc 5 = pytest collected no tests (some repos keep their test_*.py as plain scripts run by hand). Not a failure.
            if rc not in (0, 5): return False, f"tests failed; nothing deployed:\n{out[-900:]}"
        wlog(tid, "py_compile and tests passed; committing to branch " + branch)
        git("add", "-A", "--", ".", *JUNK, cwd=wt)
        git("-c", "user.name=chamber-worker", "-c", "user.email=chamber-worker@localhost", "commit", "-q", "-m",
            f"{title[:72]}\n\nChamber {tid}, approved by {t.get('approved_by')}. Made by {ME}.", cwd=wt)
        _, sha = git("rev-parse", "--short", "HEAD", cwd=wt)
        _, diff = git("show", "--stat", "--patch", "HEAD", cwd=wt)
        ticket("update", tid, note=f"Change ready on branch {branch} ({sha.strip()}). Tests passed. Deploying now.\n\n```diff\n{diff[-3500:]}\n```")
        # deploy: back up, copy in, restart, health check, roll back on failure
        _, dirty = git("status", "--porcelain", "--untracked-files=no")   # T-0146: warn (not block) when the live tree already has uncommitted edits
        dirty_files = [l[3:].strip() for l in dirty.splitlines() if l.strip()]
        if dirty_files: ticket("update", tid, note=f"Heads-up: the live repo already has {len(dirty_files)} uncommitted file(s) not from this ticket: {', '.join(dirty_files[:15])}. They are left alone; only this ticket's files are committed.")
        stamp = time.strftime("%Y%m%d-%H%M%S"); bdir = os.path.join(REPO, "backups", f"{tid}-{stamp}"); os.makedirs(bdir, exist_ok=True)
        wlog(tid, f"deploying {len(files)} file(s) into the live tree; backups in {bdir}")
        backed = []
        for f in files:
            live = os.path.join(REPO, f)
            if os.path.exists(live): shutil.copy2(live, os.path.join(bdir, os.path.basename(f))); backed.append(f)
            os.makedirs(os.path.dirname(live) or REPO, exist_ok=True); shutil.copyfile(os.path.join(wt, f), live)  # copyfile, not copy2: live files may be root-owned and copystat() then fails with EPERM [patch 2026-11-10]
        rc, out = run(["sudo", "-n", "systemctl", "restart", SERVICE])
        ok = rc == 0 and health_ok()
        wlog(tid, f"{SERVICE} restarted; health " + ("ok" if ok else "FAILED, rolling back"))
        if not ok:
            for f in files:
                live = os.path.join(REPO, f)
                if f in backed: shutil.copyfile(os.path.join(bdir, os.path.basename(f)), live)  # same reason as above
                elif os.path.exists(live): os.remove(live)
            run(["sudo", "-n", "systemctl", "restart", SERVICE])
            return False, (f"deploy failed ({SERVICE} did not come back healthy); restored {len(backed)} file(s) from {bdir} "
                           f"and restarted. Branch {branch} keeps the change for a human to look at. {out[-400:]}")
        rc_a, out_a = git("add", "--", *files)                              # T-0146: stage ONLY the deployed files (git add -A swept unrelated edits and failed on unreadable files)
        rc_c, out_c = (git("-c", "user.name=chamber-worker", "-c", "user.email=chamber-worker@localhost", "commit", "-q", "-m", f"Deploy {tid} ({sha.strip()})") if rc_a == 0 else (rc_a, out_a))
        _, live_sha = git("rev-parse", "--short", "HEAD")
        commit_note = (f"Committed to main as {live_sha.strip()}." if rc_c == 0 else f"WARNING: deploy is live but the commit to main failed ({(out_c or '').strip()[-200:]}); the change is on branch {branch} ({sha.strip()}).")
        return True, (f"Deployed {tid}: {', '.join(files)} ({sha.strip()}). Tests passed, {SERVICE} restarted and healthy. {commit_note} "
                      f"Backups in {bdir}. Model summary: {tail_summary(summary, 700)}")
    finally:
        git("worktree", "remove", "--force", wt)


def gh_slug(url):
    """1.7.0: owner/name from a GitHub remote URL (https or ssh), else None."""
    m = re.match(r"^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", (url or "").strip())
    return f"{m.group(1)}/{m.group(2)}" if m else None


def gh(method, path, body=None):
    """1.7.0: one GitHub REST call with the worker's key. Returns (status, json)."""
    req = urllib.request.Request(GH_API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                                          "User-Agent": "chamber-worker", **({"Content-Type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except ValueError: return e.code, {}
    except (urllib.error.URLError, OSError) as e: return 0, {"message": str(e)}


def git_env():
    """1.7.0: git's environment for fetch and push. For an https GitHub remote the key goes in as an extra header through the
    environment, never on the command line (where other users of the machine could see it), and git never prompts."""
    env = {k: v for k, v in os.environ.items() if k != "CHAMBER_TOKEN"}; env["GIT_TERMINAL_PROMPT"] = "0"
    _, url = git("remote", "get-url", "origin")
    if GH_TOKEN and url.strip().startswith("https://github.com/"):
        env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                    "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic " + base64.b64encode(f"x-access-token:{GH_TOKEN}".encode()).decode()})
    return env


def base_branch():
    if BASE: return BASE
    _, b = git("rev-parse", "--abbrev-ref", "HEAD")
    return (b.strip().splitlines() or ["main"])[-1] or "main"


def work_pr(t):
    """1.7.0 (T-0191): make the change on branch chamber/<ticket> from the newest base, test it, push it and open a pull request.
    Nothing is deployed and nothing is restarted. Returns (ok, message, pr_info); the ticket stays in progress while the pull
    request is open, and poll_prs() closes or hands it back."""
    tid, title, body = t["id"], t.get("title", ""), t.get("body", "")
    wt = os.path.join(WORK, tid); branch = f"chamber/{tid}"; base = base_branch()
    ok_c, why_c = claim(tid)                                             # 1.8.0: a refused claim stops here; nothing is changed or pushed
    if not ok_c: return False, f"claim refused: {why_c}", None
    presence("working", tid)
    wlog(tid, f"claimed; pull-request mode: branch {branch} from {base}, then a pull request. Nothing is deployed.")
    os.makedirs(WORK, exist_ok=True)
    with REPO_LOCK:
        rc_f, _ = run(["git", "fetch", "-q", "origin", base], cwd=REPO, env=git_env(), timeout=120)
        start = f"origin/{base}" if rc_f == 0 else base
        rc, out = run(["git", "worktree", "add", "-B", branch, wt, start], cwd=REPO)
    if rc: return False, f"could not create a worktree from {start}: {out[-300:]}", None
    try:
        prompt = (f"You are chamber-worker making the change described by Chamber ticket {tid}.\n"
                  f"TITLE: {title}\n\nBODY:\n{body}\n\n"
                  "Rules: work only inside the current directory (a git worktree of the repository). Make the smallest "
                  "correct change. Never touch keys, password or token files, databases or anything under backups/. "
                  "Run python3 -m py_compile on every .py you change and python3 -m pytest -q if tests exist. "
                  "Your change becomes a pull request that a person reviews and merges; do not deploy anything. "
                  "Finish with a 3-line summary: what changed, how you tested it, what a reviewer should look at.\n"
                  "If the ticket asks for a change to code that is not in this repo, change nothing and reply with exactly one line: "
                  "CANNOT: <where the code actually lives and why you cannot do it here>.")
        env = {k: v for k, v in os.environ.items() if k not in ("CHAMBER_TOKEN", "WORKER_GITHUB_TOKEN")}; env["HOME"] = HOME
        tools = sorted({x.split("(")[0] for x in TOOLS})
        cmd = [CLAUDE, "-p", prompt, "--output-format", "json", "--tools", *tools, "--allowedTools", *TOOLS, "--permission-mode", "dontAsk", "--max-turns", "60"]
        try:
            p = subprocess.run(cmd, cwd=wt, capture_output=True, text=True, timeout=TIMEOUT, env=env); rc = p.returncode
            summary, usage = parse_claude_json(p.stdout)
            if rc and not summary.strip(): summary = (p.stdout + p.stderr)[-4000:]
        except subprocess.TimeoutExpired: return False, f"model session exceeded {TIMEOUT}s; no pull request", None
        if usage: ticket("log", tid, usage=usage)
        if rc: return False, f"model session failed (rc={rc}): {summary[-800:]}", None
        _, changed = git("status", "--porcelain", cwd=wt)
        files = [l[3:].strip() for l in changed.splitlines() if l.strip() and not junk(l[3:].strip())]
        tail = tail_summary(summary, 600)
        wlog(tid, f"model session finished; {len(files)} file(s) changed: {', '.join(files[:8])}. Model said: {tail}", model=model_used(wt))
        if not files:
            if "CANNOT:" in summary:
                return False, f"out of scope for this worker: {summary.split('CANNOT:', 1)[1].strip().splitlines()[0][:400]}", None
            return False, f"model made no file changes; no pull request. Model said: {tail}", None
        bad = [f for f in files if denied(f)]
        if bad: return False, f"refused: change touches protected paths {bad}; no pull request", None
        for f in files:
            if f.endswith(".py"):
                rc, out = run(["python3", "-m", "py_compile", f], cwd=wt)
                if rc: return False, f"py_compile failed on {f}: {out[-600:]}; no pull request", None
        if any(fn.startswith("test_") for fn in os.listdir(wt)):
            rc, out = run(["python3", "-m", "pytest", "-q", "-x"], cwd=wt, timeout=600)
            if rc not in (0, 5): return False, f"tests failed; no pull request:\n{out[-900:]}", None
        git("add", "-A", "--", ".", *JUNK, cwd=wt)
        sd = t.get("standing") or {}
        if sd:                                                           # 1.8.0 (T-0200): Chamber checks the change against the standing approval's limits before anything is pushed
            _, names = git("diff", "--cached", "--name-only", "--no-renames", cwd=wt)
            changed_files = [n.strip() for n in names.splitlines() if n.strip()]
            try: chk = api("POST", f"/api/tickets/{tid}/standing-check", {"by": ME, "files": changed_files})
            except Exception as e: return False, f"blocked: could not ask Chamber to check the limits of standing approval {sd.get('id')} ({e}); nothing was pushed", None
            if not chk.get("ok"): return False, f"standing: {chk.get('why') or 'outside standing approval ' + str(sd.get('id'))}", None
        approved = f"approved in advance by standing approval {sd.get('id')} (set up by {sd.get('by')}: {sd.get('what')})" if sd else f"approved by {t.get('approved_by')}"
        git("-c", "user.name=chamber-worker", "-c", "user.email=chamber-worker@localhost", "commit", "-q", "-m",
            f"{title[:72]}\n\nChamber {tid}, {approved}. Made by {ME}.", cwd=wt)
        _, sha = git("rev-parse", "--short", "HEAD", cwd=wt)
        with REPO_LOCK: rc, out = run(["git", "push", "-q", "-f", "origin", f"{branch}:refs/heads/{branch}"], cwd=wt, env=git_env(), timeout=180)
        if rc: return False, f"could not push branch {branch}: {out[-300:]}", None
        _, url = git("remote", "get-url", "origin"); slug = GH_REPO or gh_slug(url)
        if not slug: return False, "pushed the branch, but cannot tell which GitHub repository this is: set WORKER_GITHUB_REPO=owner/name", None
        desc = (f"Chamber ticket {tid}, {approved}. Made by {ME}; tests passed before this was opened.\n\n{tail}\n\n"
                f"Merging this pull request closes {tid} in Chamber. Closing it without merging hands the ticket back.")
        code, pr = gh("POST", f"/repos/{slug}/pulls", {"title": f"{title[:200]} ({tid})", "head": branch, "base": base, "body": desc, "maintainer_can_modify": True})
        if code == 422:                                                  # one already open for this branch: the new commit is on it now
            _, found = gh("GET", f"/repos/{slug}/pulls?head={urllib.parse.quote(slug.split('/')[0] + ':' + branch)}&state=open")
            if isinstance(found, list) and found: code, pr = 200, found[0]
        if code not in (200, 201) or not isinstance(pr, dict) or not pr.get("html_url"):
            return False, f"pushed branch {branch}, but GitHub did not open the pull request ({code}: {str((pr or {}).get('message', ''))[:200]})", None
        info = {"url": pr["html_url"], "number": int(pr.get("number") or 0), "branch": branch, "repo": slug, "state": "open"}
        try: api("POST", f"/api/tickets/{tid}/pr", info)
        except Exception as e: log(f"could not record the pull request on {tid}: {e}")
        wlog(tid, f"pull request #{info['number']} opened: {info['url']} ({sha.strip()})")
        return True, f"Pull request #{info['number']} is open for review: {info['url']}. Tests passed; nothing was deployed. Merging it closes {tid}. Model summary: {tail}", info
    finally:
        with REPO_LOCK: run(["git", "worktree", "remove", "--force", wt], cwd=REPO)


def poll_prs(st):
    """1.7.0: once a minute, each open pull request: merged closes the ticket; closed without merging hands it back."""
    for tid, info in list((st.get("prs") or {}).items()):
        code, pr = gh("GET", f"/repos/{info['repo']}/pulls/{info['number']}")
        if code != 200 or not isinstance(pr, dict): continue
        if pr.get("merged") or pr.get("merged_at"):
            by = (pr.get("merged_by") or {}).get("login") or "someone"
            try: api("POST", f"/api/tickets/{tid}/pr", {**info, "state": "merged"})
            except Exception as e: log(f"could not mark #{info['number']} merged on {tid}: {e}")
            ticket("close", tid, note=f"Merged on GitHub by {by}: pull request #{info['number']} ({info['url']}).")
            say(f"Done {tid}: pull request #{info['number']} was merged by {by}.")
            with STATE_LOCK: st["prs"].pop(tid, None); st["done"][tid] = "merged"; save_state(st)
        elif pr.get("state") == "closed":
            try: api("POST", f"/api/tickets/{tid}/pr", {**info, "state": "closed"})
            except Exception as e: log(f"could not mark #{info['number']} closed on {tid}: {e}")
            ticket("release", tid, note=f"Pull request #{info['number']} was closed without merging, so {tid} is back to approved. Add a note to the ticket if I should try again.")
            with STATE_LOCK: st["prs"].pop(tid, None); st["done"][tid] = "pr closed"; save_state(st)


def run_one_pr(t, key, st):
    """1.7.0 (T-0192): one ticket in pull-request mode, in its own thread."""
    tid = t["id"]
    try: ok, msg, info = work_pr(t)
    except Exception as e: ok, msg, info = False, f"worker crashed: {e!r}", None
    with STATE_LOCK:
        if ok: st.setdefault("prs", {})[tid] = info
        elif not msg.startswith(("standing:", "claim refused")): st["done"][key] = "failed"   # 1.8.0: those are not failures of this worker
        save_state(st)
    if ok: say(f"Ready for review: {tid}, pull request #{info['number']} {info['url']}"); presence("idle"); return
    if msg.startswith("standing:"):                                      # 1.8.0 (T-0200): Chamber put it back to waiting for a person; nothing was pushed
        say(f"{tid} went outside its standing approval ({msg[9:].strip()[:400]}), so nothing was pushed. It waits for a person to approve it."); presence("idle"); return
    if msg.startswith("claim refused"):                                  # 1.8.0: Chamber said no (budget used up, standing-approval limits): nothing was done; look again later
        with STATE_LOCK: st.setdefault("later", {})[tid] = time.time() + 1800; save_state(st)
        if "standing approval" in msg: say(f"{tid}: {msg[15:].strip()[:400]}")
        log(f"{tid}: {msg[:300]}"); presence("idle"); return
    tag = "DECLINED: " if msg.startswith("out of scope") else ("BLOCKED: " if msg.startswith("blocked") else "FAILED: ")
    if not ticket("release", tid, note=tag + msg[:900]): ticket("update", tid, note=tag + msg)
    if not tag.startswith("DECLINED"): say(tag.title().strip(": ") + " " + tid + ": " + msg)
    presence("idle")


def main():
    st = load_state(); st.setdefault("prs", {})
    log(f"chamber-worker up: mode={MODE} repo={REPO} service={SERVICE or '-'} approvers={sorted(APPROVERS)}" + (f" parallel={PARALLEL}" if MODE == "pr" else ""))
    running = {}                                                         # 1.7.0: tickets being worked in pull-request mode, by id
    while True:
        try:
            if not running or all(not th.is_alive() for th in running.values()): presence("idle")   # without this Chamber shows the worker offline between deploys
            if MODE == "pr": poll_prs(st)
            running = {k: th for k, th in running.items() if th.is_alive()}; waiting = 0
            ts = api("GET", "/api/tickets?status=approved&for=agent").get("tickets", [])   # T-0145: the server hides [human] tickets from agents
            roles = user_roles() if ts else {}                                              # 1.3.3: only people's notes re-arm a ticket
            for t in ts:
                tid = t.get("id", ""); key = retry_key(t, roles)                        # 1.3.1: a note from a person re-arms a declined/failed ticket
                if tid in st["done"] or key in st["done"] or ticket_for(t) != "agent": continue
                if tid in running or tid in (st.get("prs") or {}): continue                  # 1.7.0: already being worked / waiting for its pull request   # 1.4.0: the ticket's own 'for' field decides
                if time.time() < (st.get("later") or {}).get(tid, 0): continue                # 1.8.0: Chamber refused the claim a moment ago
                sd = t.get("standing") or {}
                if sd and str(sd.get("agent", "")).lower() != ME.lower(): continue            # 1.8.0 (T-0200): a standing approval names the one agent that may do the job
                if "[human]" in t.get("title", "").lower(): st["done"][tid] = "skipped: tagged [human]"; save_state(st); continue   # T-0145 interim: never claim a human ticket
                if t.get("approved_by") not in APPROVERS:
                    st["done"][tid] = "skipped: approver not allowed"; save_state(st); continue
                v, why = triage(t)                                          # 1.3.0: is this ticket for this worker at all?
                if v == "out":
                    st["done"][key] = "declined: " + why[:200]; save_state(st)
                    wlog(tid, f"triage by {ME}: not for this worker ({why}). Left approved and unclaimed for whoever owns that code.")
                    others, proposer_ai = who_else(t)
                    if others or (proposer_ai and "not committed" not in why): log(f"{tid} declined ({why}); other workers online: {others}; proposed by an agent: {proposer_ai}")
                    else: say(f"@{t.get('approved_by') or ''} {tid} is not something I can do: {why}. I am the only worker online, so nobody will pick it up. "
                             "If it is for a person, open the ticket and switch it to 'A person'; if it is for code on another machine, add a worker there (gear menu > Add an agent); if it is a duplicate, cancel it.")
                    continue
                wlog(tid, f"triage by {ME}: in scope ({why})")
                if MODE == "pr":                                               # 1.7.0 (T-0192): up to PARALLEL at once, each in its own thread and worktree
                    if tid in running: continue
                    if len(running) >= PARALLEL: waiting += 1; continue
                    th = threading.Thread(target=run_one_pr, args=(t, key, st), daemon=True); th.start(); running[tid] = th; continue
                try: ok, msg = work(t)
                except Exception as e: ok, msg = False, f"worker crashed: {e!r}"  # still post FAILED + record state instead of a silent loop error [patch 2026-11-10]
                if not ok and msg.startswith("claim refused"):                  # 1.8.0: Chamber said no (budget used up, standing-approval limits): nothing was done; look again later
                    st.setdefault("later", {})[tid] = time.time() + 1800; save_state(st); log(f"{tid}: {msg[:300]}")
                    if "standing approval" in msg: say(f"{tid}: {msg[15:].strip()[:400]}")
                    continue
                st["done"][tid if ok else key] = "ok" if ok else "failed"; save_state(st)
                tag = "DECLINED: " if msg.startswith("out of scope") else ("BLOCKED: " if msg.startswith("blocked") else "FAILED: ")
                if ok: ticket("close", tid, note=msg)
                elif not ticket("release", tid, note=tag + msg[:900]):          # 1.3.0: never leave a ticket sitting in progress on me
                    ticket("update", tid, note=tag + msg)                        # (older Chamber refuses an agent release: at least record why)
                if ok or not tag.startswith("DECLINED"): say(("Done " if ok else tag.title().strip(": ") + " ") + tid + ": " + msg)
                else: log(f"{tid} handed back quietly (reason is on the ticket): {msg[:200]}")   # 1.5.0 (T-0164): a ticket that was never its job is not chat news
            if waiting and not st.get("queue_note"):                    # 1.7.0 (T-0192): say once when work queues up behind the limit
                say(f"{waiting} approved ticket{'s' if waiting != 1 else ''} wait{'s' if waiting == 1 else ''} for a free slot: I work on {PARALLEL} at a time (WORKER_PARALLEL)."); st["queue_note"] = True
            elif not waiting and st.get("queue_note"): st["queue_note"] = False
        except Exception as e:
            log(f"loop error: {e}")
        time.sleep(60)


if __name__ == "__main__":
    main()
