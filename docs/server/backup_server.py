#!/usr/bin/env python3
"""Backup store for the Portfolio app. Standard library only.

Each device that opens the app keeps its own copy here; any device can list
the copies and restore one. Run it on the machine that serves the app and
expose it next to the app under /api, for example with Tailscale Serve:

    python backup_server.py --port 8765 --dir ~/portfolio-data
    tailscale serve --bg --https=8443 --set-path=/api http://127.0.0.1:8765

It listens on 127.0.0.1 only, so nothing reaches it except through that mount.

    GET  /health            {"ok": true, "app": "portfolio-backup"}
    GET  /backups           [{"id", "label", "updated", "count"}]
    GET  /backups/<id>      the stored copy
    PUT  /backups/<id>      body {"label": str, "data": {"holdings": [...], ...}}

Files: <dir>/<id>.json is the latest copy. <dir>/history/<id>-<YYYYMMDD>.json
keeps the last copy of each day for KEEP_DAYS days, as restore points to pick
up by hand if a bad copy ever overwrites a good one.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ID_RE = re.compile(r"^[a-z0-9]{6,40}$")
MAX_BODY = 2 * 1024 * 1024
KEEP_DAYS = 14


def write_atomic(path, text):
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class Store:
    def __init__(self, folder):
        self.folder = folder
        self.history = os.path.join(folder, "history")
        os.makedirs(self.history, exist_ok=True)

    def path(self, ident):
        return os.path.join(self.folder, ident + ".json")

    def list(self):
        out = []
        for name in os.listdir(self.folder):
            ident, ext = os.path.splitext(name)
            if ext != ".json" or not ID_RE.match(ident):
                continue
            try:
                doc = read_json(self.path(ident))
                out.append({"id": ident, "label": doc.get("label", ""), "updated": doc.get("updated", ""), "count": doc.get("count", 0)})
            except (OSError, ValueError):
                continue
        return out

    def get(self, ident):
        try:
            return read_json(self.path(ident))
        except (OSError, ValueError):
            return None

    def put(self, ident, label, data):
        now = time.gmtime()
        doc = {
            "id": ident,
            "label": str(label)[:60],
            "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", now),
            "count": len(data["holdings"]),
            "data": data,
        }
        text = json.dumps(doc, ensure_ascii=False)
        write_atomic(self.path(ident), text)
        write_atomic(os.path.join(self.history, "%s-%s.json" % (ident, time.strftime("%Y%m%d", now))), text)
        self.prune(ident)
        return doc

    def prune(self, ident):
        days = sorted(n for n in os.listdir(self.history) if n.startswith(ident + "-") and n.endswith(".json"))
        for name in days[:-KEEP_DAYS]:
            try:
                os.remove(os.path.join(self.history, name))
            except OSError:
                pass


class Handler(BaseHTTPRequestHandler):
    server_version = "PortfolioBackup/1"
    store = None

    def log_message(self, *args):  # stay quiet: there may be no console at all
        pass

    def parts(self):
        path = self.path.split("?", 1)[0]
        # Works whether or not the reverse proxy strips the /api prefix.
        if path == "/api" or path.startswith("/api/"):
            path = path[4:]
        return [p for p in path.split("/") if p]

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = self.parts()
        if parts == ["health"]:
            return self.send_json(200, {"ok": True, "app": "portfolio-backup", "version": 1})
        if parts == ["backups"]:
            return self.send_json(200, self.store.list())
        if len(parts) == 2 and parts[0] == "backups" and ID_RE.match(parts[1]):
            doc = self.store.get(parts[1])
            return self.send_json(200, doc) if doc else self.send_json(404, {"error": "not found"})
        self.send_json(404, {"error": "not found"})

    def do_PUT(self):
        parts = self.parts()
        if not (len(parts) == 2 and parts[0] == "backups" and ID_RE.match(parts[1])):
            return self.send_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.send_json(411, {"error": "length required"})
        if length <= 0 or length > MAX_BODY:
            return self.send_json(413, {"error": "too large"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.send_json(400, {"error": "invalid json"})
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict) or not isinstance(data.get("holdings"), list):
            return self.send_json(400, {"error": "data.holdings required"})
        # An empty portfolio never replaces a copy that has positions.
        old = self.store.get(parts[1])
        if not data["holdings"] and old and old.get("count"):
            return self.send_json(409, {"error": "refusing to replace a copy with an empty one"})
        doc = self.store.put(parts[1], body.get("label", ""), data)
        self.send_json(200, {"ok": True, "updated": doc["updated"], "count": doc["count"]})


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):  # a dropped connection is not news
        pass


def main():
    ap = argparse.ArgumentParser(description="Backup store for the Portfolio app")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dir", default=os.path.join(os.path.expanduser("~"), "portfolio-data"))
    args = ap.parse_args()

    Handler.store = Store(os.path.abspath(os.path.expanduser(args.dir)))
    try:
        server = QuietServer(("127.0.0.1", args.port), Handler)
    except OSError:
        sys.exit(0)  # the port is taken: another copy of this server is already running
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
