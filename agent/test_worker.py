#!/usr/bin/env python3
"""Unit tests for chamber-worker's triage (T-0151). Stdlib only, Python 3.9+. Run: python3 agent/test_worker.py

Imports agent/chamber-worker.py as a module against a throwaway git repo, with no model available, so every
decision here comes from the rules and the parser; the model path is covered by the 'unsure' fallbacks.
"""
import importlib.util, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="chamber-worker-test-")
REPO = os.path.join(TMP, "repo"); os.makedirs(os.path.join(REPO, "docs")); os.makedirs(os.path.join(REPO, "scripts"))
for f in ("app.py", "watchdog.py", "docs/startup.md", "scripts/agent.sh", "mail.py"):
    open(os.path.join(REPO, f), "w").write("# test\n")
subprocess.run(["git", "init", "-q", REPO], check=True)
subprocess.run(["git", "-C", REPO, "add", "-A"], check=True)
subprocess.run(["git", "-C", REPO, "-c", "user.email=t@test", "-c", "user.name=t", "commit", "-qm", "init"], check=True)

os.environ.update({"CHAMBER_TOKEN": "test-token", "CHAMBER_URL": "https://chamber.invalid", "WORKER_REPO": REPO, "WORKER_SERVICE": "test-service", "WORKER_APPROVERS": "alice",
                   "WORKER_HOME": os.path.join(TMP, "home"), "WORKER_CLAUDE": os.path.join(TMP, "no-such-claude"),
                   "CHAMBER_AGENT_NAME": "chamber-worker", "WORKER_TRIAGE": "auto"})


def load():
    spec = importlib.util.spec_from_file_location("chamber_worker", os.path.join(HERE, "chamber-worker.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


W = load()
passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok: passed += 1; print("  ok   " + name)
    else: failed += 1; print("  FAIL " + name + (" " + str(detail) if detail else ""))


inv = W.repo_inventory()
check("inventory lists the repo's tracked files", set(inv) >= {"app.py", "docs/startup.md", "scripts/agent.sh"}, inv)

print("paths_in")
check("finds paths and code files, drops URLs and 'e.g.'", W.paths_in("Fix public/index.html and server.js, e.g. see https://x.test/a/b.py and /srv/myapp/mail.py")
      == ["public/index.html", "server.js", "srv/myapp/mail.py"], W.paths_in("Fix public/index.html and server.js, e.g. see https://x.test/a/b.py and /srv/myapp/mail.py"))
check("plain prose yields nothing", W.paths_in("Add a delete button to the Files tab, with a confirm on phones.") == [])
check("a version number is not a file", W.paths_in("bump to 3.15.2 and 1.0") == [])

print("triage_rules")
rules = lambda title, body="": W.triage_rules({"id": "T-0001", "title": title, "body": body}, inv)
check("names a file in this repo -> in", rules("[agent] rate-limit sign-in in app.py")[0] == "in", rules("[agent] rate-limit sign-in in app.py"))
check("absolute path under the live tree -> in", rules("[agent] rotate /srv/myapp/docs/startup.md")[0] == "in" or rules("[agent] rotate " + REPO + "/docs/startup.md")[0] == "in")
check("a directory this repo has -> in", rules("[agent] tidy docs/")[0] == "in")
check("two files this repo lacks -> out", rules("[agent] Files tab delete", "edit public/index.html and server.js")[0] == "out", rules("[agent] Files tab delete", "edit public/index.html and server.js"))
check("one unknown file alone is not enough -> undecided", rules("[agent] fix server.js")[0] is None)
check("prose only -> undecided", rules("[agent] Files tab delete + folders", "Add delete with confirm and per-workspace folders.")[0] is None)
check("[worker:other] in the title -> out", rules("[agent] [worker:shop-worker] fix the cart in app.py")[0] == "out")
check("[worker:me] in the title -> in even with foreign paths", rules("[agent] [worker:chamber-worker] do it", "public/index.html server.js")[0] == "in")

open(os.path.join(REPO, "docs", "untracked.md"), "w").write("# not committed\n")
r = rules("[agent] append a section to docs/untracked.md")
check("a file present on disk but not committed -> out, with the fix in the reason", r[0] == "out" and "not committed" in r[1] and "untracked.md" in r[1], r)
print("retry_key")
check("no notes -> @0", W.retry_key({"id": "T-0009"}) == "T-0009@0")
check("my own notes do not re-arm; a person's note does", W.retry_key({"id": "T-0009", "updates": [{"by": "chamber-worker", "note": "FAILED: x"}]}) == "T-0009@0" and W.retry_key({"id": "T-0009", "updates": [{"by": "chamber-worker", "note": "x"}, {"by": "alice", "note": "fixed, retry"}]}) == "T-0009@1")
roles = {"helper-bot": "ai", "alice": "human"}
check("another agent's note does not re-arm when roles are known; unknown names still count", W.retry_key({"id": "T-0009", "updates": [{"by": "helper-bot", "note": "applied"}, {"by": "alice", "note": "retry"}, {"by": "newbie", "note": "?"}]}, roles) == "T-0009@2")

print("parse_triage")
check("OUT line", W.parse_triage("OUT: the Chamber app repo on another box") == ("out", "the Chamber app repo on another box"))
check("bold IN line with a preamble", W.parse_triage("Sure.\n**IN**: app.py and mail.py")[0] == "in")
check("UNSURE line", W.parse_triage("UNSURE - the ticket names no files")[0] == "unsure")
check("garbage -> unsure", W.parse_triage("I think so, probably?")[0] == "unsure")
check("empty -> unsure", W.parse_triage("")[0] == "unsure")

print("triage end to end (no model available)")
t_prose = {"id": "T-0002", "title": "[agent] Files tab delete + folders", "body": "Add delete with confirm and folders to the Files tab."}
v, why = W.triage(t_prose)
check("auto: undecided + no model -> in (trying anyway), with the reason", v == "in" and "unsure" in why and "no model" in why, (v, why))
check("rules decide without a model: foreign files -> out", W.triage({"id": "T-0003", "title": "[agent] x", "body": "public/index.html and server.js"})[0] == "out")
os.environ["WORKER_TRIAGE"] = "strict"; WS = load()
check("strict: undecided + no model -> out", WS.triage(t_prose)[0] == "out")
del os.environ["WORKER_TRIAGE"]; WD = load()
check("1.5.0: with no setting the worker is strict: unsure means leave it alone", WD.TRIAGE == "strict" and WD.triage(t_prose)[0] == "out" and "leaving it alone" in WD.triage(t_prose)[1])
src = open(os.path.join(HERE, "chamber-worker.py"), encoding="utf-8").read()
check("1.5.0: no Starting message is posted to the room, and no advice to retag titles remains", 'say(f"Starting' not in src and "Retag the ticket [human]" not in src and "retag it [human]" not in src)
os.environ["WORKER_TRIAGE"] = "off"; WO = load()
check("off: everything is in", WO.triage({"id": "T-0004", "title": "[agent] x", "body": "public/index.html and server.js"}) == ("in", "triage off"))
os.environ["WORKER_TRIAGE"] = "auto"

print("tail_summary")
ts = W.tail_summary("lots of work\n\n- **What changed:** added a section\n- **Testing:** py_compile ok\n- **Watch:** nothing", 200)
check("keeps whole closing lines in order", ts.startswith("lots of work") and ts.endswith("- **Watch:** nothing"), ts)
check("drops the oldest lines first when over the limit", W.tail_summary("a" * 150 + "\nB line\nC line", 20) == "B line C line")
check("a single very long line is cut, never empty", len(W.tail_summary("x" * 1000, 50)) == 50 and W.tail_summary("", 50) == "")

print("ticket_for")
check("explicit field wins over the title", W.ticket_for({"for": "human", "title": "[agent] x"}) == "human" and W.ticket_for({"for": "agent", "title": "x"}) == "agent")
check("title tag is the fallback; nothing -> None", W.ticket_for({"title": "[agent] x"}) == "agent" and W.ticket_for({"title": "[human] x"}) == "human" and W.ticket_for({"title": "x"}) is None)

print("settings")
_env = {k: v for k, v in os.environ.items() if k != "WORKER_SERVICE"}
_r = subprocess.run([sys.executable, os.path.join(HERE, "chamber-worker.py")], env=_env, capture_output=True, text=True, timeout=30)
check("1.5.1: the worker refuses to start without WORKER_SERVICE: there are no built-in defaults", _r.returncode != 0 and "WORKER_SERVICE" in (_r.stderr + _r.stdout), (_r.returncode, (_r.stderr + _r.stdout)[-200:]))
os.environ["WORKER_DENY"] = "private/*, *.pfx"; WX = load(); del os.environ["WORKER_DENY"]
check("1.5.1: WORKER_DENY adds never-deploy patterns to the built-in ones", WX.denied("private/x.txt") and WX.denied("a.pfx") and WX.denied("auth.json") and WX.denied("data.db") and not WX.denied("app.py") and not W.denied("private/x.txt"))
check("1.5.1: nothing from our own servers is left in the worker (paths, file names, account names)", not any(s in src for s in ("/opt/ghost", "Ghost" + "Admin", "fleet" + ".db", "control-plane")))
print("version")
check("worker reports a worker-* version line", W.WORKER_VERSION.startswith("worker-") and W.WORKER_VERSION >= "worker-1.3.0", W.WORKER_VERSION)

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
