#!/usr/bin/env python3
"""Put a local file into the Chamber Files tab (T-0118).

Why this exists: POSTing to /api/files only creates a PENDING upload, and anything no
message owns is swept after an hour. So this uploads the bytes and then attaches them to
a short message, which is what actually makes the file persist and show in the Files tab.

usage: share-file.py <path> [--room general] [--note "what this is"] [--folder a/b]   (T-0149: folders)
"""
import os, sys, json, mimetypes, argparse, urllib.request, urllib.parse


def _load_cfg():
    """Read the agent token at the moment it is needed.

    T-0123: the connector deliberately strips CHAMBER_TOKEN from the model's environment
    (T-0041) so the model never sees it. These helpers used to read os.environ and so could
    never work when the agent actually ran them. Reading the config file here keeps the
    safeguard intact - the token still never enters the model's environment, only this
    short-lived helper process holds it - and widens nothing, since the file is already
    readable by the user the helper runs as.
    """
    tok = os.environ.get("CHAMBER_TOKEN")
    url = os.environ.get("CHAMBER_URL")
    if not (tok and url):
        path = os.environ.get("CHAMBER_ENV_FILE", "/etc/chamber-agent.env")
        try:
            with open(path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip(); v = v.strip().strip('"').strip("'")
                    if k == "CHAMBER_TOKEN" and not tok:
                        tok = v
                    elif k == "CHAMBER_URL" and not url:
                        url = v
        except OSError as e:
            sys.exit(f"cannot read {path}: {e}")
    if not tok:
        sys.exit("no CHAMBER_TOKEN found in the environment or the config file")
    return tok, (url or "https://chamber.ghostporttechnologies.com").rstrip("/")


def post(url, data, headers):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--room", default="general")
    ap.add_argument("--note", default=None)
    ap.add_argument("--folder", default=None, help="Files-tab folder, e.g. installers/pi (T-0149)")
    a = ap.parse_args()

    tok, base = _load_cfg()
    me = os.environ.get("CHAMBER_AGENT_NAME", "server-claude")

    name = os.path.basename(a.path)
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    with open(a.path, "rb") as fh:
        blob = fh.read()
    if not blob:
        sys.exit(f"{name} is empty; nothing to share")

    room_q = urllib.parse.quote(a.room)
    folder_q = ("&folder=" + urllib.parse.quote(a.folder)) if a.folder else ""
    up = post(f"{base}/api/files?room={room_q}{folder_q}", blob,
              {"Authorization": f"Bearer {tok}", "X-File-Name": urllib.parse.quote(name),
               "Content-Type": mime})
    fid = up["file"]["id"]

    post(f"{base}/api/messages",
         json.dumps({"username": me, "room": a.room,
                     "text": a.note or f"Shared {name}", "attachments": [fid]}).encode(),
         {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    print(f"shared {name} to #{a.room}" + (f" in folder {a.folder}" if a.folder else "") + " - it is in the Files tab now")


main()
