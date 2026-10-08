# Dev server with caching disabled (python tools/serve.py [port] [shot_dir])
# POST /__shot?name=foo with a data-URL body saves foo.png into shot_dir (debug screenshots).
import http.server, sys, base64, os, urllib.parse
SHOT_DIR = sys.argv[2] if len(sys.argv) > 2 else None
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a): pass
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != '/__shot' or not SHOT_DIR:
            self.send_response(404); self.end_headers(); return
        name = urllib.parse.parse_qs(u.query).get('name', ['shot'])[0]
        name = ''.join(c for c in name if c.isalnum() or c in '-_') or 'shot'
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        data = base64.b64decode(body.split(',', 1)[1])
        with open(os.path.join(SHOT_DIR, name + '.png'), 'wb') as f: f.write(data)
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8123), H).serve_forever()
