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
print("cost reporting (1.6.0, T-0194)")
txt, use = W.parse_claude_json('{"type":"result","result":"Changed app.py.\\nTested.","total_cost_usd":0.0421,"duration_ms":5120,"usage":{"input_tokens":10,"cache_read_input_tokens":2000,"output_tokens":300}}')
check("the closing text and the cost come out of the JSON answer", txt.startswith("Changed app.py") and use == {"tokens_in": 2010, "tokens_out": 300, "ms": 5120, "cost_cents": 4.21}, (txt, use))
check("an older plain-text answer is kept as it is, with no cost", W.parse_claude_json("Changed it.\nCANNOT: not here") == ("Changed it.\nCANNOT: not here", None))
print("pull-request mode (1.7.0, T-0191 and T-0192)")
import http.server, json, re, threading, time
PRT = tempfile.mkdtemp(prefix="chamber-worker-pr-")
ORIGIN, CLONE, SEED = os.path.join(PRT, "origin.git"), os.path.join(PRT, "clone"), os.path.join(PRT, "seed")
subprocess.run(["git", "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
subprocess.run(["git", "init", "-q", "-b", "main", SEED], check=True); open(os.path.join(SEED, "app.py"), "w").write("x = 1\n")
subprocess.run(["git", "-C", SEED, "add", "-A"], check=True)
subprocess.run(["git", "-C", SEED, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], check=True)
subprocess.run(["git", "-C", SEED, "push", "-q", ORIGIN, "main"], check=True)
subprocess.run(["git", "clone", "-q", ORIGIN, CLONE], check=True)
GH = {"posts": [], "state": {}}
class GHH(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        GH["posts"].append((self.path, body, self.headers.get("Authorization"))); n = len(GH["posts"]); GH["state"][n] = {"state": "open", "merged": False}
        self._send(201, {"html_url": "https://github.com/o/r/pull/%d" % n, "number": n})
    def do_GET(self):
        m = re.match(r"^/repos/o/r/pulls/(\d+)$", self.path)
        if m and int(m.group(1)) in GH["state"]: self._send(200, dict(number=int(m.group(1)), **GH["state"][int(m.group(1))]))
        else: self._send(404, {})
ghs = http.server.ThreadingHTTPServer(("127.0.0.1", 0), GHH); threading.Thread(target=ghs.serve_forever, daemon=True).start()
fake = os.path.join(PRT, "fakeclaude")
open(fake, "w").write("#!/usr/bin/env python3\nimport json, os, time\ntime.sleep(float(os.environ.get('FAKE_SLEEP', '0')))\n"
                      "open(os.environ['FAKE_ENV_OUT'], 'w').write('\\n'.join(sorted(os.environ)))\n"
                      "open('app.py', 'w').write('x = 2\\n')\nprint(json.dumps({'type': 'result', 'result': 'Changed app.py.\\nTested.\\nLook at x.', 'total_cost_usd': 0.01}))\n")
os.chmod(fake, 0o755)
os.environ.update({"WORKER_MODE": "pr", "WORKER_GITHUB_TOKEN": "gh-test-key", "WORKER_GITHUB_API": "http://127.0.0.1:%d" % ghs.server_address[1], "WORKER_GITHUB_REPO": "o/r",
                   "WORKER_REPO": CLONE, "WORKER_CLAUDE": fake, "WORKER_HOME": os.path.join(PRT, "home"), "WORKER_PARALLEL": "9", "FAKE_ENV_OUT": os.path.join(PRT, "env.txt")})
os.environ.pop("WORKER_SERVICE", None)
WP = load(); calls = []
WP.api = lambda m, p, b=None: (calls.append((m, p, b)), {})[1]
WP.ticket = lambda verb, tid, **kw: (calls.append(("ticket", verb, tid, kw)), True)[1]
WP.say = lambda text: calls.append(("say", text)); WP.presence = lambda *a, **k: None
check("pull-request mode starts without WORKER_SERVICE; parallel is capped at 5; live mode stays one at a time", WP.MODE == "pr" and WP.PARALLEL == 5 and W.PARALLEL == 1)
check("GitHub remotes are read as owner/name", WP.gh_slug("https://github.com/o/r.git") == "o/r" and WP.gh_slug("git@github.com:o/r.git") == "o/r" and WP.gh_slug("/srv/x.git") is None)
ok, msg, info = WP.work_pr({"id": "T-0042", "title": "Set x to 2", "body": "x should be 2", "approved_by": "alice"})
pushed = subprocess.run(["git", "-C", ORIGIN, "show", "chamber/T-0042:app.py"], capture_output=True, text=True).stdout
post = GH["posts"][0] if GH["posts"] else ("", {}, "")
check("an approved ticket becomes a pushed branch and a pull request into main, and the ticket records it", ok and pushed == "x = 2\n" and post[0] == "/repos/o/r/pulls" and post[1].get("head") == "chamber/T-0042" and post[1].get("base") == "main" and post[2] == "Bearer gh-test-key" and ("POST", "/api/tickets/T-0042/pr", info) in calls and info and info["state"] == "open", (ok, msg[:200], post[:2]))
check("nothing is deployed: the clone's own checkout is unchanged", open(os.path.join(CLONE, "app.py")).read() == "x = 1\n")
check("the GitHub key never reaches the AI's environment", "WORKER_GITHUB_TOKEN" not in open(os.environ["FAKE_ENV_OUT"]).read().split("\n"))
st = {"done": {}, "prs": {"T-0042": info}}
WP.poll_prs(st); still = "T-0042" in st["prs"]
GH["state"][1] = {"state": "closed", "merged": True, "merged_at": "2026-11-13T00:00:00Z", "merged_by": {"login": "bob"}}
WP.poll_prs(st)
check("an open pull request is left alone; merging it closes the ticket with a note", still and "T-0042" not in st["prs"] and st["done"].get("T-0042") == "merged" and any(c[0] == "ticket" and c[1] == "close" and c[2] == "T-0042" and "bob" in c[3].get("note", "") for c in calls))
ok2, msg2, info2 = WP.work_pr({"id": "T-0043", "title": "Another", "body": "x", "approved_by": "alice"}); st["prs"]["T-0043"] = info2
GH["state"][info2["number"]] = {"state": "closed", "merged": False}; WP.poll_prs(st)
check("closing the pull request without merging hands the ticket back", ok2 and st["done"].get("T-0043") == "pr closed" and any(c[0] == "ticket" and c[1] == "release" and c[2] == "T-0043" for c in calls))
os.environ["FAKE_SLEEP"] = "1.5"; t0 = time.time()
ths = [threading.Thread(target=WP.run_one_pr, args=({"id": "T-005%d" % i, "title": "job %d" % i, "body": "x", "approved_by": "alice"}, "T-005%d@0" % i, st)) for i in range(3)]
for th in ths: th.start()
for th in ths: th.join()
took = time.time() - t0
check("three tickets run side by side, each with its own branch and pull request", took < 4.2 and all("T-005%d" % i in st["prs"] for i in range(3)) and len(set(st["prs"]["T-005%d" % i]["number"] for i in range(3))) == 3, (round(took, 2), list(st["prs"])))
print("standing approvals and refused claims (1.8.0, T-0200)")
os.environ["FAKE_SLEEP"] = "0"
import io, urllib.error
GH["posts"].clear(); del calls[:]
def api_refuse(m, p, b=None):
    calls.append((m, p, b))
    if p.endswith("/claim"): raise urllib.error.HTTPError("https://chamber.invalid" + p, 402, "Payment Required", {}, io.BytesIO(b'{"error":"The AI budget for November is used up"}'))
    return {}
WP.api = api_refuse; st2 = {"done": {}, "prs": {}}
WP.run_one_pr({"id": "T-0061", "title": "job", "body": "x", "approved_by": "alice"}, "T-0061@0", st2)
check("1.8.0: when Chamber refuses the claim (budget used up) nothing is worked or pushed, nothing is marked done, and it is looked at again later", not GH["posts"] and "T-0061@0" not in st2["done"] and st2.get("later", {}).get("T-0061", 0) > time.time() and not any(c[0] == "ticket" and c[1] == "release" for c in calls) and ("POST", "/api/tickets/T-0061/claim", {"by": "chamber-worker", "mode": "pr"}) in calls, (GH["posts"], st2))
sent = {}
def api_standing(verdict):
    def f(m, p, b=None):
        calls.append((m, p, b))
        if p.endswith("/standing-check"): sent["files"] = b.get("files"); return verdict
        return {}
    return f
SD = {"id": "S-1", "what": "fix failing tests", "agent": "chamber-worker", "by": "alice", "maxFiles": 5, "paths": ["tests/"]}
WP.api = api_standing({"ok": False, "why": "the change touches files outside tests/: app.py"}); del calls[:]
WP.run_one_pr({"id": "T-0062", "title": "Fix tests", "body": "x", "approved_by": "alice", "standing": SD}, "T-0062@0", st2)
nopush = subprocess.run(["git", "-C", ORIGIN, "rev-parse", "--verify", "-q", "refs/heads/chamber/T-0062"], capture_output=True).returncode != 0
check("1.8.0: a ticket started by a standing approval is checked by Chamber before anything is pushed; outside the limits nothing is pushed, the room is told, and it is not marked done", nopush and not GH["posts"] and sent.get("files") == ["app.py"] and not any("__pycache__" in f for f in sent.get("files")) and "T-0062@0" not in st2["done"] and any(c[0] == "say" and "went outside" in c[1] for c in calls), (nopush, sent, st2))
WP.api = api_standing({"ok": True}); GH["posts"].clear(); del calls[:]
ok3, msg3, info3 = WP.work_pr({"id": "T-0063", "title": "Fix tests", "body": "x", "approved_by": "alice", "standing": SD})
check("1.8.0: inside the limits the pull request opens and says which standing approval started it", ok3 and GH["posts"] and "standing approval S-1" in GH["posts"][0][1].get("body", ""), (ok3, msg3[:200]))
check("1.8.0: the worker tells Chamber its mode when it claims", any(c[0] == "POST" and c[1] == "/api/tickets/T-0063/claim" and (c[2] or {}).get("mode") == "pr" for c in calls))
check("1.8.0: the live-folder loop also stops on a refused claim and skips standing tickets meant for another agent", 'msg.startswith("claim refused")' in src and 'sd.get("agent", "")).lower() != ME.lower()' in src)
del os.environ["FAKE_SLEEP"]; ghs.shutdown()
for k in ("WORKER_MODE", "WORKER_GITHUB_TOKEN", "WORKER_GITHUB_API", "WORKER_GITHUB_REPO", "WORKER_PARALLEL", "FAKE_ENV_OUT"): os.environ.pop(k, None)

print("version")
check("worker reports a worker-* version line", W.WORKER_VERSION.startswith("worker-") and W.WORKER_VERSION >= "worker-1.3.0", W.WORKER_VERSION)

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
