# Static server for docs/ plus a tiny ntfy-compatible relay at /relay/<topic> (POST) and /relay/<topic>/sse.
# Also records every relay body so tests can check that only ciphertext passes through.
import json, os, sys, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
ROOT, PORT = sys.argv[1], int(sys.argv[2]); NORELAY = os.environ.get("NORELAY") == "1"
msgs, cond = {}, threading.Condition()
LOG = open("/tmp/relay_log.txt", "w")
class H(SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(s, *a): pass
    def do_POST(s):
        if not s.path.startswith("/relay/") or NORELAY:
            s.send_response(503); s.end_headers(); return
        t = s.path.split("/")[2]; body = s.rfile.read(int(s.headers.get("Content-Length", 0))).decode()
        LOG.write(body + "\n"); LOG.flush()
        with cond: msgs.setdefault(t, []).append(body); cond.notify_all()
        s.send_response(200); s.send_header("Content-Type", "application/json"); s.end_headers(); s.wfile.write(b"{}")
    def do_GET(s):
        if s.path.startswith("/relay/") and "/sse" in s.path:
            topics = s.path.split("/")[2].split(",")
            since_all = "since=all" in s.path
            s.send_response(200); s.send_header("Content-Type", "text/event-stream"); s.send_header("Cache-Control", "no-cache"); s.end_headers()
            with cond: sent = {t: (0 if since_all else len(msgs.get(t, []))) for t in topics}
            try:
                s.wfile.write(b'event: open\ndata: {"event":"open"}\n\n'); s.wfile.flush()
                while True:
                    with cond:
                        cond.wait(timeout=1)
                        new = [(t, m) for t in topics for m in msgs.get(t, [])[sent[t]:]]
                        for t in topics: sent[t] = len(msgs.get(t, []))
                    for t, m in new:
                        s.wfile.write(("data: " + json.dumps({"event": "message", "topic": t, "message": m}) + "\n\n").encode()); s.wfile.flush()
            except Exception: return
        return super().do_GET()
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
