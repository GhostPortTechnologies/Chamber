#!/usr/bin/env python3
"""Tidy the Chamber Files tab from an agent (T-0273).

usage: files.py list [--loose] [--folder a/b]     list files: id, folder, date, who shared it, size, name
       files.py move <id> <folder>                move a file into a folder ("" or / = the top level)
       files.py delete <id>                       delete a file (the message it came with stays)
       files.py same <id> <id>                    are two files byte-for-byte the same? (check before deleting a "duplicate")

What an agent may change: its own files, plus the files of a person who approved a [files] ticket (the tag is
in the title) the agent is working on right now. Anything else gets a 403 that says so. Every move and delete is on the workspace record.
SPDX-License-Identifier: AGPL-3.0-only. Copyright (C) 2026 GhostPort Technologies
"""
import os, sys, json, time, hashlib, importlib.util, urllib.request, urllib.parse, urllib.error

def _cfg():
    """Same token handling as share-file.py (T-0123): read the config file only inside this short-lived helper,
    so the token never enters the model's environment."""
    spec = importlib.util.spec_from_file_location("_sf", os.path.join(os.path.dirname(os.path.abspath(__file__)), "share-file.py"))
    src = open(spec.origin).read().split("\ndef post(")[0]          # only _load_cfg and the imports, not main()
    ns = {}; exec(compile(src, spec.origin, "exec"), ns)
    return ns["_load_cfg"]()

def call(method, path, body=None, raw=False):
    tok, base = _cfg()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {tok}", **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read(); return b if raw else json.loads(b or b"{}")
    except urllib.error.HTTPError as e:
        try: msg = json.loads(e.read()).get("error")
        except Exception: msg = None
        sys.exit(f"{method} refused ({e.code}): {msg or e.reason}")

def fid(x):
    if not (len(x) == 24 and all(c in "0123456789abcdef" for c in x)): sys.exit(f"not a file id: {x} (24 hex characters, from 'files.py list')")
    return x

def main(a):
    if not a or a[0] in ("-h", "--help", "help"): print(__doc__.strip()); return
    cmd = a[0]
    if cmd == "list":
        folder = a[a.index("--folder") + 1] if "--folder" in a else None
        q = "?limit=500" + ("&folder=" + urllib.parse.quote(folder) if folder is not None else "")
        fs = call("GET", "/api/files" + q).get("files", [])
        if "--loose" in a: fs = [f for f in fs if not f.get("folder")]
        for f in fs:
            print(f'{f["id"]}  {f.get("folder") or "/":<28} {time.strftime("%Y-%m-%d", time.gmtime(f["ts"] / 1000))}  {f.get("by", "?"):<14} {f.get("size", 0):>9}  {f["name"]}')
        print(f"{len(fs)} file(s)")
    elif cmd == "move" and len(a) == 3:
        folder = "" if a[2] in ("", "/") else a[2]
        r = call("PATCH", f"/api/files/{fid(a[1])}", {"folder": folder})
        print(f'moved {r["file"]["name"]} to {r["file"].get("folder") or "/"}')
    elif cmd == "delete" and len(a) == 2:
        call("DELETE", f"/api/files/{fid(a[1])}"); print(f"deleted {a[1]}")
    elif cmd == "same" and len(a) == 3:
        h = [hashlib.sha256(call("GET", f"/api/files/{fid(x)}", raw=True)).hexdigest() for x in a[1:]]
        print("same bytes" if h[0] == h[1] else "DIFFERENT bytes"); sys.exit(0 if h[0] == h[1] else 1)
    else:
        sys.exit(__doc__.strip())

main(sys.argv[1:])
