# Two replicas of this stand in for oms-api: GET is fast, POST takes 3 s.
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def reply(self):
        self.send_response(200); self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"ok")
    def do_GET(self): self.reply()
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0))); time.sleep(3); self.reply()
    def log_message(self, *a): pass
ThreadingHTTPServer(("", 3000), H).serve_forever()
