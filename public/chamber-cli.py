#!/usr/bin/env python3
"""chamber — a command-line client for Chamber (T-0074). Python 3 standard library only.

Install:  curl -fsSLo ~/.local/bin/chamber https://chamber.ghostporttechnologies.com/chamber-cli.py && chmod +x ~/.local/bin/chamber
Sign in:  chamber login https://chamber.ghostporttechnologies.com        (asks for your email/username and password; MFA supported)
          or export CHAMBER_URL=... CHAMBER_TOKEN=chk_...                (an agent token works too)

  chamber whoami                         who you are, which workspace
  chamber rooms                          rooms you can see
  chamber post <room> <text...>          post a message (text may also come from stdin:  cmd | chamber post general -)
  chamber files up <path> [--room r] [--folder a/b]   upload a file and post it (images show inline)
  chamber files ls [--room r] [--folder a/b]          shared files (T-0149: folders)
  chamber tickets ls [--status s]        the board
  chamber tickets show T-0012            one ticket with its diff summary
  chamber tickets approve|reject|close T-0012 [--reason ..|--note ..]   (approve: owner / admin)
  chamber tail <room> [--seconds n]      follow a room in the terminal (Ctrl-C to stop)
  chamber search <words...> [--from u] [--room r]

Config lives in ~/.config/chamber/config.json (mode 600). Exit code 0 on success, 1 on an error, 2 on usage.
SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
"""
import json, os, sys, time, getpass, urllib.request, urllib.error, urllib.parse, mimetypes

CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "chamber", "config.json")
VERSION = "1.0.0"

def load_config():
    cfg = {}
    try: cfg = json.load(open(CONFIG))
    except Exception: pass
    if os.environ.get("CHAMBER_URL"): cfg["url"] = os.environ["CHAMBER_URL"]
    if os.environ.get("CHAMBER_TOKEN"): cfg["token"] = os.environ["CHAMBER_TOKEN"]
    cfg["url"] = (cfg.get("url") or "").rstrip("/")
    return cfg

def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, json.dumps(cfg, indent=2).encode()); os.close(fd)

def die(msg, code=1): print(msg, file=sys.stderr); sys.exit(code)

class Client:
    def __init__(self, cfg):
        if not cfg.get("url") or not cfg.get("token"): die("Not signed in. Run: chamber login <url>   (or set CHAMBER_URL and CHAMBER_TOKEN)", 2)
        self.url, self.token = cfg["url"], cfg["token"]
    def req(self, method, path, body=None, raw=None, headers=None, timeout=30):
        h = {"Authorization": "Bearer " + self.token, "User-Agent": "chamber-cli/" + VERSION}
        if body is not None: h["Content-Type"] = "application/json"; data = json.dumps(body).encode()
        else: data = raw
        h.update(headers or {})
        r = urllib.request.Request(self.url + path, method=method, data=data, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                ct = resp.headers.get("Content-Type", "")
                return json.load(resp) if "json" in ct else resp.read()
        except urllib.error.HTTPError as e:
            try: msg = json.load(e).get("error") or e.reason
            except Exception: msg = e.reason
            die("%s %s -> %s: %s" % (method, path, e.code, msg))
        except urllib.error.URLError as e:
            die("cannot reach %s: %s" % (self.url, e.reason))

def arg_opt(args, name, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args): die("%s needs a value" % name, 2)
        v = args[i + 1]; del args[i:i + 2]; return v
    return default

def fmt_ts(ms): return time.strftime("%H:%M", time.localtime(ms / 1000))

def cmd_login(args):
    url = (args[0] if args else input("Chamber URL: ")).strip().rstrip("/")
    if not url.startswith("http"): url = "https://" + url
    who = input("Email or username: ").strip(); pw = getpass.getpass("Password: ")
    def post(path, body):
        r = urllib.request.Request(url + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "chamber-cli/" + VERSION})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp: return json.load(resp)
        except urllib.error.HTTPError as e:
            try: die(json.load(e).get("error") or str(e))
            except SystemExit: raise
            except Exception: die(str(e))
    d = post("/account/login", {"email": who, "password": pw})
    if d.get("mfa"):
        code = input("Authenticator code (or a recovery code): ").strip()
        d = post("/account/login/totp", {"mfaToken": d["mfaToken"], "code": code})
    if not d.get("token"): die("login did not return a token")
    save_config({"url": url, "token": d["token"], "username": (d.get("account") or {}).get("username")})
    print("Signed in as %s. Config saved to %s" % ((d.get("account") or {}).get("username", "?"), CONFIG))

def cmd_whoami(c, args):
    me = c.req("GET", "/api/me"); print("%s (%s) at %s" % (me.get("username"), me.get("wsRole") or me.get("role"), c.url))

def cmd_rooms(c, args):
    rooms = c.req("GET", "/api/rooms").get("rooms", {})
    for k, r in sorted(rooms.items()):
        label = "@" + "/".join(r["dm"]) if r.get("dm") else "#" + (r.get("name") or k)
        print("%-24s %s%s" % (k, label, ("  — " + r["topic"]) if r.get("topic") else ""))

def read_text(parts):
    if parts == ["-"] or not parts: return sys.stdin.read().strip()
    return " ".join(parts)

def cmd_post(c, args):
    if not args: die("usage: chamber post <room> <text...>", 2)
    room = args[0]; text = read_text(args[1:])
    if not text: die("nothing to post", 2)
    m = c.req("POST", "/api/messages", {"text": text, "room": room}).get("message", {})
    print("posted %s in #%s" % (m.get("id"), m.get("room")))

def cmd_files(c, args):
    if not args: die("usage: chamber files up <path> [--room r] | chamber files ls [--room r]", 2)
    sub, rest = args[0], args[1:]; room = arg_opt(rest, "--room", "general"); folder = arg_opt(rest, "--folder", None)   # T-0149
    if sub == "ls":
        q = {}
        if "--room" in sys.argv: q["room"] = room
        if folder is not None: q["folder"] = folder
        d = c.req("GET", "/api/files" + ("?" + urllib.parse.urlencode(q) if q else ""))
        for f in d.get("files", []): print("%-26s %8d  %-12s %s  #%s  %s%s" % (f["id"], f["size"], f["by"], fmt_ts(f["ts"]), f.get("room") or "?", (f.get("folder") + "/") if f.get("folder") else "", f["name"]))
        print("%d files, %.1f MB of %s MB" % (len(d.get("files", [])), (d.get("bytes") or 0) / 1048576, d.get("quota_mb")))
        return
    if sub != "up" or not rest: die("usage: chamber files up <path> [--room r]", 2)
    path = rest[0]; text = read_text(rest[1:]) if len(rest) > 1 else ""
    try: data = open(path, "rb").read()
    except OSError as e: die(str(e))
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    f = c.req("POST", "/api/files?room=" + urllib.parse.quote(room) + ("&folder=" + urllib.parse.quote(folder) if folder else ""), raw=data, headers={"Content-Type": mime, "X-File-Name": urllib.parse.quote(os.path.basename(path))}, timeout=120).get("file", {})
    m = c.req("POST", "/api/messages", {"text": text, "room": room, "attachments": [f["id"]]}).get("message", {})
    print("uploaded %s (%d bytes) as %s; message %s in #%s" % (f.get("name"), f.get("size", 0), f.get("id"), m.get("id"), room))

def cmd_tickets(c, args):
    if not args: die("usage: chamber tickets ls [--status s] | show <id> | approve|reject|close <id> [--reason ..|--note ..]", 2)
    sub, rest = args[0], args[1:]
    if sub == "ls":
        status = arg_opt(rest, "--status")
        tix = c.req("GET", "/api/tickets" + ("?status=" + urllib.parse.quote(status) if status else "")).get("tickets", [])
        for t in tix: print("%-7s %-11s %-8s %-14s %s%s" % (t["id"], t["status"], t.get("priority", ""), (t.get("proposed_by") or "")[:14], t["title"][:70], "  [diff]" if t.get("hasDiff") else ""))
        print("%d tickets" % len(tix)); return
    if not rest: die("ticket id required", 2)
    tid = rest[0]
    if sub == "show":
        t = next((x for x in c.req("GET", "/api/tickets").get("tickets", []) if x["id"] == tid), None)
        if not t: die("no such ticket")
        print("%s — %s\nstatus: %s · type: %s · priority: %s · proposed by %s at %s" % (t["id"], t["title"], t["status"], t.get("type"), t.get("priority"), t.get("proposed_by"), t.get("proposed_at")))
        if t.get("applied"): print("applied by %s on %s (%s)" % (t["applied"].get("by"), t["applied"].get("branch"), t["applied"].get("sha")))
        print("\n" + (t.get("body") or "(no body)"))
        if t.get("hasDiff"):
            d = c.req("GET", "/api/tickets/%s/diff" % tid); m = d.get("meta", {})
            print("\nDiff: %d file(s), +%s -%s%s" % (len(m.get("files") or []), m.get("added", 0), m.get("removed", 0), ("; " + m["plain"].get("what", "")) if m.get("plain") else ""))
        for u in t.get("updates") or []: print("  %s %s: %s" % (u.get("at", "")[:16], u.get("by"), u.get("note")))
        return
    if sub in ("approve", "reject", "close", "claim"):
        me = c.req("GET", "/api/me"); body = {"by": me.get("username")}
        if sub == "reject": body["reason"] = arg_opt(rest, "--reason") or die("--reason required", 2)
        if sub == "close": body["note"] = arg_opt(rest, "--note") or die("--note required (min 20 chars)", 2)
        print(c.req("POST", "/api/tickets/%s/%s" % (tid, sub), body).get("message", "ok")); return
    die("unknown tickets command: " + sub, 2)

def cmd_search(c, args):
    frm = arg_opt(args, "--from"); room = arg_opt(args, "--room")
    q = urllib.parse.urlencode({k: v for k, v in [("q", " ".join(args)), ("from", frm), ("room", room)] if v})
    for m in c.req("GET", "/api/search?" + q).get("results", []): print("#%s %s %s: %s" % (m["room"], fmt_ts(m["ts"]), m["username"], m["text"].replace("\n", " ")[:160]))

def cmd_tail(c, args):
    if not args: die("usage: chamber tail <room> [--seconds n]", 2)
    room = args[0]; secs = float(arg_opt(args, "--seconds", "0") or 0)
    since = int(time.time() * 1000); deadline = time.time() + secs if secs else None
    print("following #%s (Ctrl-C to stop)" % room, file=sys.stderr)
    def drain():
        nonlocal since
        for m in sorted(c.req("GET", "/api/messages?room=%s&since=%d" % (urllib.parse.quote(room), since)).get("messages", []), key=lambda x: x["ts"]):
            if m["ts"] > since: since = m["ts"]
            if m.get("deleted"): continue
            print("%s %s%s: %s%s" % (fmt_ts(m["ts"]), m["username"], " (status)" if m.get("type") == "status" else "", m["text"].replace("\n", "\n    "), ("  [%d file(s)]" % len(m["attachments"])) if m.get("attachments") else ""), flush=True)
    try:
        while True:
            try:
                r = urllib.request.Request(c.url + "/api/events", headers={"Authorization": "Bearer " + c.token, "Accept": "text/event-stream", "User-Agent": "chamber-cli/" + VERSION})
                left = max(1.0, min(30.0, deadline - time.time())) if deadline else 30.0   # a read timeout wakes us up to check the deadline
                with urllib.request.urlopen(r, timeout=left) as resp:
                    for raw in resp:
                        line = raw.decode("utf-8", "replace").rstrip("\n")
                        if line.startswith("data:") and '"messages"' in line: drain()
                        if deadline and time.time() > deadline: return
            except (urllib.error.URLError, OSError, TimeoutError):
                drain()                                                          # polling fallback while the stream is down
                if deadline and time.time() > deadline: return
                time.sleep(2)
    except KeyboardInterrupt:
        return

def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"): print(__doc__.strip()); return 0
    if argv[0] == "--version": print("chamber-cli " + VERSION); return 0
    if argv[0] == "login": cmd_login(argv[1:]); return 0
    c = Client(load_config())
    cmds = {"whoami": cmd_whoami, "rooms": cmd_rooms, "post": cmd_post, "files": cmd_files, "tickets": cmd_tickets, "tail": cmd_tail, "search": cmd_search}
    fn = cmds.get(argv[0])
    if not fn: die("unknown command %r; run: chamber help" % argv[0], 2)
    fn(c, argv[1:]); return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
